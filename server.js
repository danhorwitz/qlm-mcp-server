import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ─── Config ────────────────────────────────────────────────────────────────
// Set these in your cloud provider's environment variable settings.
// QLM_BASE_URL: e.g. https://yourserver.com/qlmwebservice/qlmservice.asmx
// QLM_VENDOR:   your QLM vendor/username
// QLM_PASSWORD: your QLM API password

const QLM_BASE_URL = process.env.QLM_BASE_URL?.replace(/\/$/, "");
const QLM_VENDOR = process.env.QLM_VENDOR;
const QLM_PASSWORD = process.env.QLM_PASSWORD;

if (!QLM_BASE_URL || !QLM_VENDOR || !QLM_PASSWORD) {
  console.error(
    "Missing required environment variables: QLM_BASE_URL, QLM_VENDOR, QLM_PASSWORD"
  );
  process.exit(1);
}

// ─── QLM API Helper ─────────────────────────────────────────────────────────
// Calls QLM REST endpoints. QLM returns JSON when you pass is_returnformat=json.
// Adjust endpoint names here if your QLM version uses different method names.
async function qlmRequest(method, params = {}) {
  const url = new URL(`${QLM_BASE_URL}/${method}`);

  const allParams = {
    is_vendor: QLM_VENDOR,
    is_pwd: QLM_PASSWORD,
    is_returnformat: "json",
    ...params,
  };

  for (const [key, value] of Object.entries(allParams)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`QLM API HTTP error: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    // QLM sometimes returns XML or plain text on errors
    return { raw: text };
  }
}

// ─── Tool Definitions ───────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "get_license_info",
    description:
      "Look up full details for a license by its activation key. Returns product info, seat count, expiry date, and maintenance status.",
    inputSchema: {
      type: "object",
      properties: {
        activation_key: {
          type: "string",
          description: "The QLM activation/license key to look up",
        },
      },
      required: ["activation_key"],
    },
  },
  {
    name: "get_activation_status",
    description:
      "Check the activation status of a license key — shows which computers have it activated, how many seats are used vs. available, and whether it's currently active.",
    inputSchema: {
      type: "object",
      properties: {
        activation_key: {
          type: "string",
          description: "The QLM activation/license key",
        },
      },
      required: ["activation_key"],
    },
  },
  {
    name: "search_customers",
    description:
      "Search for customers by name, email address, or company. Returns a list of matching customers with their IDs and contact info.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search term — name, email, or company",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_customer_orders",
    description:
      "Get all orders associated with a customer email address. Returns order IDs, dates, products, and license keys.",
    inputSchema: {
      type: "object",
      properties: {
        customer_email: {
          type: "string",
          description: "The customer's email address",
        },
      },
      required: ["customer_email"],
    },
  },
  {
    name: "get_order",
    description:
      "Get full details for a specific order by its order ID, including line items, license keys, and status.",
    inputSchema: {
      type: "object",
      properties: {
        order_id: {
          type: "string",
          description: "The QLM order ID",
        },
      },
      required: ["order_id"],
    },
  },
];

// ─── Tool Handlers ──────────────────────────────────────────────────────────
// Map tool names to QLM API method calls.
// If your QLM version uses different endpoint names, update them here.
async function callTool(name, args) {
  switch (name) {
    case "get_license_info":
      return qlmRequest("GetLicenseInfo", {
        is_activationkey: args.activation_key,
      });

    case "get_activation_status":
      return qlmRequest("GetActivationStatus", {
        is_activationkey: args.activation_key,
      });

    case "search_customers":
      return qlmRequest("GetCustomers", {
        is_search: args.query,
      });

    case "get_customer_orders":
      return qlmRequest("GetOrders", {
        is_email: args.customer_email,
      });

    case "get_order":
      return qlmRequest("GetOrder", {
        is_orderid: args.order_id,
      });

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP Server Factory ─────────────────────────────────────────────────────
// A new Server instance is created per SSE connection.
function createMCPServer() {
  const server = new Server(
    { name: "qlm-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await callTool(name, args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ─── Express App ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Track active SSE sessions
const sessions = new Map();

// SSE endpoint — Claude.ai connects here to open an MCP session
app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  const server = createMCPServer();

  sessions.set(transport.sessionId, { transport, server });

  res.on("close", () => {
    sessions.delete(transport.sessionId);
  });

  await server.connect(transport);
});

// Message endpoint — Claude.ai posts tool calls here
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  await session.transport.handlePostMessage(req, res);
});

// Health check — useful for cloud provider uptime monitoring
app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "qlm-mcp-server", version: "1.0.0" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`QLM MCP Server listening on port ${PORT}`);
  console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
});
