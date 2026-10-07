import OpenAI from "openai";
import { config } from "../config.js";

// Nebius Token Factory speaks the OpenAI Chat Completions protocol, so we can
// reuse the official `openai` SDK simply by pointing it at Nebius's base URL.
// Constructed even in DEMO_MODE (with a placeholder key) since it's cheap and
// never actually called unless config.isDemoMode is false.
export const nebius = new OpenAI({
  apiKey: config.nebiusApiKey || "demo-mode-placeholder-key",
  baseURL: config.nebiusBaseUrl,
});

export interface CompletionOptions {
  system?: string;
  temperature?: number;
  model?: string;
  jsonMode?: boolean;
}

/**
 * Runs a single chat completion against an NVIDIA Nemotron model served by
 * Nebius Token Factory. Used by every agent for its reasoning/drafting step.
 *
 * In DEMO_MODE (no NEBIUS_API_KEY configured) this returns a canned response
 * instead of making a network call, so the pipeline still runs end-to-end
 * without any credentials.
 *
 * Deliberately has no dependency on the MCP client/server (see
 * llm/nebiusClient.ts for the tool-calling variant that does) — this keeps
 * this module a leaf that any agent can import (including ones reachable
 * from inside an MCP tool handler, like chatIntakeAgent) without risking an
 * import cycle back into mcp/server.ts.
 */
export async function completeText(
  prompt: string,
  options: CompletionOptions = {}
): Promise<string> {
  if (config.isDemoLlm) {
    return `[demo mode - no Nebius API key configured] Nemotron would respond here to: ${prompt.slice(0, 160)}...`;
  }

  const response = await nebius.chat.completions.create({
    model: options.model ?? config.nebiusModel,
    temperature: options.temperature ?? 0.2,
    response_format: options.jsonMode ? { type: "json_object" } : undefined,
    messages: [
      ...(options.system ? [{ role: "system" as const, content: options.system }] : []),
      { role: "user" as const, content: prompt },
    ],
  });

  return response.choices[0]?.message?.content?.trim() ?? "";
}

/** Same as completeText, but parses the model's response as JSON. */
export async function completeJson<T>(prompt: string, options: CompletionOptions = {}): Promise<T> {
  const raw = await completeText(prompt, { ...options, jsonMode: true });
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`Model did not return valid JSON: ${raw}`);
  }
}
