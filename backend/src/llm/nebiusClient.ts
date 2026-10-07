import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { config } from "../config.js";
import { listMcpToolsAsOpenAiTools, callMcpTool } from "../mcp/client.js";
import { listVendorMcpToolsAsOpenAiTools, callVendorTool } from "../mcp/vendorClient.js";
import { nebius, completeText, completeJson, type CompletionOptions } from "./nemotron.js";

// Re-exported for backward compatibility — completeText/completeJson now
// live in nemotron.ts (a leaf module with no MCP dependency) so agents that
// only need plain completions (e.g. chatIntakeAgent, reachable from inside
// the `place_order` MCP tool handler) can avoid importing this file and the
// import cycle it would create back into mcp/server.ts.
export { completeText, completeJson, type CompletionOptions };

export interface ToolCallingResult<T> {
  result: T;
  /** Names of MCP tools the model actually invoked while reasoning, in call order (for logging/transparency). */
  toolCallsMade: string[];
}

/** A pluggable source of MCP tools for the shared tool-calling loop below —
 * either our own catalog server (mcp/client.ts) or an external party's
 * server (e.g. mcp/vendorClient.ts's vendor server), so the identical
 * round-trip/dispatch logic can be reused against either without
 * duplicating it. */
interface McpToolAdapter {
  listTools: () => Promise<ChatCompletionTool[]>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
}

const ownMcpAdapter: McpToolAdapter = {
  listTools: async () => (await listMcpToolsAsOpenAiTools()) as ChatCompletionTool[],
  callTool: callMcpTool,
};

const vendorMcpAdapter: McpToolAdapter = {
  listTools: async () => (await listVendorMcpToolsAsOpenAiTools()) as ChatCompletionTool[],
  callTool: callVendorTool,
};

/**
 * Shared multi-turn Nemotron tool-calling loop: the model can call any tool
 * exposed by `adapter` as many times as it needs (dispatched via the
 * adapter's `callTool`) before returning its final JSON answer. Extracted
 * so both `completeJsonWithMcpTools` (our own catalog tools) and
 * `completeJsonWithVendorMcpTools` (an external vendor's tools, for
 * Replenishment Agent negotiation) share the exact same round-trip logic.
 *
 * Only meaningful outside DEMO_MODE, since it requires a real model that
 * supports function calling; callers should branch on config.isDemoMode
 * themselves and use a deterministic fallback there.
 */
async function runToolCallingLoop<T>(
  adapter: McpToolAdapter,
  prompt: string,
  options: CompletionOptions,
  maxToolRounds: number
): Promise<ToolCallingResult<T>> {
  const tools = await adapter.listTools();
  const toolCallsMade: string[] = [];

  const messages: ChatCompletionMessageParam[] = [
    ...(options.system ? [{ role: "system" as const, content: options.system }] : []),
    { role: "user" as const, content: prompt },
  ];

  for (let round = 0; round <= maxToolRounds; round++) {
    const isFinalRound = round === maxToolRounds;
    const response = await nebius.chat.completions.create({
      model: options.model ?? config.nebiusModel,
      temperature: options.temperature ?? 0.2,
      // This model appears to treat response_format:"json_object" as an
      // instruction to answer immediately in JSON, skipping any tool calls
      // it would otherwise make — so only force JSON mode once tools are no
      // longer offered (the final round), never while it still has the
      // option to call a tool.
      response_format: isFinalRound ? { type: "json_object" } : undefined,
      // Force a final answer (no more tool calls) once we've used up our tool-call budget.
      tools: isFinalRound ? undefined : tools,
      messages,
    });

    const choice = response.choices[0];
    const message = choice?.message;
    const toolCalls = message?.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      const raw = message?.content?.trim() ?? "";
      try {
        return { result: JSON.parse(raw) as T, toolCallsMade };
      } catch {
        throw new Error(`Model did not return valid JSON: ${raw}`);
      }
    }

    messages.push(message);
    // Tool calls within a round are independent (e.g. several check_inventory
    // lookups for different SKUs), so dispatch them concurrently instead of
    // one at a time — this is what makes multi-item PO extraction fast.
    const toolResults = await Promise.all(
      toolCalls.map(async (call) => {
        toolCallsMade.push(call.function.name);
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          // Leave args empty if the model produced malformed JSON for this call.
        }
        const toolResultText = await adapter.callTool(call.function.name, args).catch(
          (err) => `Error calling ${call.function.name}: ${(err as Error).message}`
        );
        return { tool_call_id: call.id, content: toolResultText };
      })
    );
    for (const { tool_call_id, content } of toolResults) {
      messages.push({ role: "tool", tool_call_id, content });
    }
  }

  throw new Error("Exhausted tool-calling rounds without a final answer");
}

/**
 * Runs a multi-turn Nemotron tool-calling loop against every tool exposed by
 * our MCP server (backend/src/mcp/server.ts): the model can call
 * `list_inventory`, `check_inventory`, etc. as many times as it needs
 * (dispatched via the MCP client) before returning its final JSON answer.
 * This is what lets an agent ground its output in *live* data rather than a
 * static snapshot pasted into the prompt.
 */
export async function completeJsonWithMcpTools<T>(
  prompt: string,
  options: CompletionOptions = {},
  maxToolRounds = 4
): Promise<ToolCallingResult<T>> {
  return runToolCallingLoop<T>(ownMcpAdapter, prompt, options, maxToolRounds);
}

/**
 * Same tool-calling loop as `completeJsonWithMcpTools`, but scoped to an
 * *external vendor's* MCP server (mcp/vendorServer.ts, via
 * mcp/vendorClient.ts) instead of our own catalog — used by the
 * Replenishment Agent to let Nemotron negotiate a restock order's price
 * and lead time (propose_restock_order / finalize_restock_order) rather
 * than accepting the vendor's list price outright.
 */
export async function completeJsonWithVendorMcpTools<T>(
  prompt: string,
  options: CompletionOptions = {},
  maxToolRounds = 4
): Promise<ToolCallingResult<T>> {
  return runToolCallingLoop<T>(vendorMcpAdapter, prompt, options, maxToolRounds);
}

