import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createVendorMcpServer } from "./vendorServer.js";

/**
 * A second, independent MCP client<->server pair — deliberately separate
 * from mcp/client.ts's own-catalog client. This one represents *our*
 * connection, as a buyer, to an *external vendor's* MCP server
 * (mcp/vendorServer.ts). Keeping it as its own client/server boundary
 * (rather than registering the vendor's tools on our own McpServer) is what
 * makes this genuine agent-to-agent commerce: the Replenishment Agent talks
 * to another party's system through a protocol boundary, not through a
 * shared in-process object graph. Swapping InMemoryTransport for
 * StdioClientTransport/an HTTP MCP transport later — to point at a real
 * vendor's real MCP endpoint — needs no changes to the tool-calling code
 * that uses this client.
 */
let vendorClientPromise: Promise<Client> | null = null;

async function getVendorMcpClient(): Promise<Client> {
  if (!vendorClientPromise) {
    vendorClientPromise = (async () => {
      const server = createVendorMcpServer();
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "autocom-replenishment-agent", version: "0.1.0" });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      return client;
    })();
  }
  return vendorClientPromise;
}

/** Invokes a tool on the vendor's MCP server and returns its text content. */
export async function callVendorTool(name: string, args: Record<string, unknown>): Promise<string> {
  const client = await getVendorMcpClient();
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

/** Lists every tool the vendor's MCP server exposes, converted to OpenAI
 * function-calling schema — mirrors mcp/client.ts's
 * listMcpToolsAsOpenAiTools() but scoped to the vendor's own tools only, so
 * a Nemotron negotiation loop (see llm/nebiusClient.ts's
 * completeJsonWithVendorMcpTools) never sees our own catalog tools. */
export async function listVendorMcpToolsAsOpenAiTools(): Promise<
  Array<{ type: "function"; function: { name: string; description?: string; parameters: Record<string, unknown> } }>
> {
  const client = await getVendorMcpClient();
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
