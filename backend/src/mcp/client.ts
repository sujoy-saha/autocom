import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./server.js";

/**
 * A single MCP client wired to our own in-process MCP server via a linked
 * in-memory transport pair. This is genuine MCP client/server traffic
 * (JSON-RPC requests/responses over the MCP protocol) — just carried over
 * an in-process channel instead of stdio/HTTP, which keeps the hackathon
 * demo dependency-free (no extra subprocess to spawn/manage) while still
 * exercising the real client<->server boundary. Swapping in
 * StdioServerTransport/StdioClientTransport later (to run the MCP server as
 * its own process, or expose it to an external MCP host like Claude Desktop)
 * would need no changes to the tool definitions themselves.
 */
let clientPromise: Promise<Client> | null = null;

async function getMcpClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const server = createMcpServer();
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "autocom-agents", version: "0.1.0" });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      return client;
    })();
  }
  return clientPromise;
}

/** An MCP tool, shaped for the OpenAI-compatible `tools` parameter used by Nemotron function-calling. */
export interface OpenAiToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

/** Lists every tool this MCP server exposes, converted to OpenAI function-calling schema. */
export async function listMcpToolsAsOpenAiTools(): Promise<OpenAiToolDef[]> {
  const client = await getMcpClient();
  const { tools } = await client.listTools();
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
    },
  }));
}

/** Invokes an MCP tool by name and returns its text content (models/agents deal in strings). */
export async function callMcpTool(name: string, args: Record<string, unknown>): Promise<string> {
  const client = await getMcpClient();
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}
