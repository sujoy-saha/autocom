import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "../store/index.js";
import { createOrderFromText } from "../services/orderService.js";
import { webSearch } from "../services/tavilySearch.js";

/**
 * AutoCom's own MCP server: exposes live inventory/order data
 * as MCP tools so agent LLM calls (Nemotron) can look things up during
 * reasoning instead of relying on whatever was stuffed into the prompt.
 * Any MCP-compatible client (our own agents, but also Claude Desktop, other
 * copilots, etc.) can attach to this the same way.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "autocom", version: "0.1.0" });

  server.registerTool(
    "list_inventory",
    {
      title: "List inventory catalog",
      description: "Returns every SKU in the live product catalog with its name, price, and quantity available.",
      inputSchema: {},
    },
    async () => {
      const catalog = await db.getInventoryCatalog();
      return { content: [{ type: "text", text: JSON.stringify(catalog) }] };
    }
  );

  server.registerTool(
    "check_inventory",
    {
      title: "Check inventory for a SKU",
      description:
        "Looks up a single SKU in the live product catalog and returns its available quantity, or null if the SKU is unknown.",
      inputSchema: { sku: z.string().describe("The SKU/item number to look up") },
    },
    async ({ sku }) => {
      const quantityAvailable = await db.getInventoryQuantity(sku);
      return {
        content: [{ type: "text", text: JSON.stringify({ sku, quantityAvailable }) }],
      };
    }
  );

  server.registerTool(
    "ensure_inventory_item",
    {
      title: "Register a new inventory item",
      description:
        "Registers a SKU that isn't yet in the catalog (e.g. an external vendor's own item number from an uploaded purchase order), so it can be reserved against. No-op if the SKU already exists.",
      inputSchema: {
        sku: z.string(),
        name: z.string(),
        quantityAvailable: z.number(),
        unitPrice: z.number(),
      },
    },
    async ({ sku, name, quantityAvailable, unitPrice }) => {
      await db.ensureInventoryItem(sku, name, quantityAvailable, unitPrice);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, sku }) }] };
    }
  );

  server.registerTool(
    "web_search",
    {
      title: "Search the live web",
      description:
        "Searches the public web (via Tavily) and returns the top matching pages' title, URL, and a short " +
        "relevant content snippet. Use this when the catalog/order tools don't have an answer — e.g. finding " +
        "a real alternative supplier for a short SKU, or answering a general customer question (shipping " +
        "policy, carrier info, etc.). Returns an empty result list if web search isn't configured.",
      inputSchema: {
        query: z.string().describe("The search query"),
        maxResults: z.number().optional().describe("Max number of results to return (default 3)"),
      },
    },
    async ({ query, maxResults }) => {
      const results = await webSearch(query, maxResults);
      return { content: [{ type: "text", text: JSON.stringify({ results }) }] };
    }
  );

  server.registerTool(
    "get_order_status",
    {
      title: "Get order status",
      description:
        "Returns an order's current status, customer, items/total, payment, shipment (carrier/tracking " +
        "number), any customer notifications sent, and the full agent activity log.",
      inputSchema: { orderId: z.string() },
    },
    async ({ orderId }) => {
      const details = await db.getOrderDetails(orderId);
      return { content: [{ type: "text", text: JSON.stringify(details) }] };
    }
  );

  server.registerTool(
    "place_order",
    {
      title: "Place an order from a chat message",
      description:
        "Places a new order from a customer's free-text request (e.g. from a web chat bot), matching the " +
        "requested items against the live product catalog by SKU or name, then running it through the full " +
        "inventory -> payment -> fulfillment -> support pipeline. Returns the created order's id, matched " +
        "items/total, and final status (or which parts of the request couldn't be matched to the catalog).",
      inputSchema: {
        customerEmail: z.string().describe("The customer's email address, used to create/look up their account"),
        customerName: z.string().optional().describe("The customer's name, if known"),
        message: z
          .string()
          .describe("The customer's plain-English order request, e.g. '2 wireless mice and a mechanical keyboard'"),
      },
    },
    async ({ customerEmail, customerName, message }) => {
      const order = await createOrderFromText({ customerEmail, customerName, message });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              orderId: order.orderId,
              orderNumber: order.orderNumber,
              items: order.items,
              totalAmount: order.totalAmount,
              extractionMethod: order.extractionMethod,
              unmatchedText: order.unmatchedText,
              status: order.result?.status ?? "intake_failed",
            }),
          },
        ],
      };
    }
  );

  return server;
}
