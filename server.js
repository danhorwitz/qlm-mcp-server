import express from "express";
import crypto from "crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ─── Config ────────────────────────────────────────────────────────────────
const QLM_BASE_URL = process.env.QLM_BASE_URL?.replace(/\/$/, "");
const QLM_VENDOR = process.env.QLM_VENDOR;
const QLM_PASSWORD = process.env.QLM_PASSWORD;
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : `http://localhost:${PORT}`;

if (!QLM_BASE_URL || !QLM_VENDOR || !QLM_PASSWORD) {
  console.error("Missing required environment variables: QLM_BASE_URL, QLM_VENDOR, QLM_PASSWORD");
  process.exit(1);
}

// ─── OAuth In-Memory Stores ─────────────────────────────────────────────────
const registeredClients = new Map();
const authCodes = new Map();
const accessTokens = new Set();

// ─── QLM API Helper ─────────────────────────────────────────────────────────
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
    return { raw: text };
  }
}

// ─── MCP Tools ──────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "get_license_info",
    description: "Look up full details for a license by its activation key.",
    inputSchema: {
      type: "object",
      properties: {
        activation_key: { type: "string", description: "The QLM activation/license key" },
      },
      required: ["activation_key"],
    },
  },
  {
    name: "get_activation_status",
    description: "Check activation status of a license — seats used, computers activated, active/inactive.",
    inputSchema: {
      type: "object",
      properties: {
        activation_key: { type: "string", description: "The QLM activation/license key" },
      },
      required: ["activation_key"],
    },
  },
  {
    name: "search_customers",
    description: "Search for customers by name, email, or company.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term — name, email, or company" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_customer_orders",
    description: "Get all orders for a customer email address.",
    inputSchema: {
      type: "object",
      properties: {
        customer_email: { type: "string", description: "Customer email address" },
      },
      required: ["customer_email"],
    },
  },
  {
    name: "get_order",
    description: "Get details for a specific order by order ID.",
    inputSchema: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "The QLM order ID" },
      },
      required: ["order_id"],
    },
  },
];

async function callTool(name, args) {
  switch (name) {
    case "get_license_info":
      return qlmRequest("GetLicenseInfo", { is_activationkey: args.activation_key });
    case "get_activation_status":
      return qlmRequest("GetActivationStatus", { is_activationkey: args.activation_key });
    case "search_customers":
      return qlmRequest("GetCustomers", { is_search: args.query });
    case "get_customer_orders":
      return qlmRequest("GetOrders", { is_email: args.customer_email });
    case "get_order":
      return qlmRequest("GetOrder", { is_orderid: args.order_id });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP Server Factory ──────────────────────────────────────────────────────
function createMCPServer() {
  const server = new Server(
    { name: "qlm-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await callTool(name, args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
  });
  return server;
}

// ─── Express App ─────────────────────────────────────────────────────────────
const app = express();

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── OAuth 2.0 ───────────────────────────────────────────────────────────────
app.get("/.well-known/oauth-protected-resource", (req, res) => {
  res.json({ resource: BASE_URL, authorization_servers: [BASE_URL] });
});

app.get("/.well-known/oauth-authorization-server", (req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/oauth/authorize`,
    token_endpoint: `${BASE_URL}/oauth/token`,
    registration_endpoint: `${BASE_URL}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
  });
});

app.post("/oauth/register", (req, res) => {
  const client_id = crypto.randomBytes(16).toString("hex");
  const client_secret = crypto.randomBytes(32).toString("hex");
  const client = { client_id, client_secret, ...req.body, client_id_issued_at: Math.floor(Date.now() / 1000) };
  registeredClients.set(client_id, client);
  console.log(`OAuth client registered: ${client_id}`);
  res.status(201).json(client);
});

app.get("/oauth/authorize", (req, res) => {
  const { redirect_uri, state, code_challenge, code_challenge_method, client_id } = req.query;
  const code = crypto.randomBytes(16).toString("hex");
  authCodes.set(code, { client_id, redirect_uri, code_challenge, code_challenge_method, expiresAt: Date.now() + 300000 });
  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (state) redirectUrl.searchParams.set("state", state);
  res.redirect(redirectUrl.toString());
});

app.post("/oauth/token", (req, res) => {
  const { grant_type, code, code_verifier } = req.body;
  if (grant_type !== "authorization_code") return res.status(400).json({ error: "unsupported_grant_type" });
  const authCode = authCodes.get(code);
  if (!authCode || authCode.expiresAt < Date.now()) return res.status(400).json({ error: "invalid_grant" });
  if (authCode.code_challenge && code_verifier) {
    const hash = crypto.createHash("sha256").update(code_verifier).digest("base64url");
    if (hash !== authCode.code_challenge) return res.status(400).json({ error: "invalid_grant" });
  }
  authCodes.delete(code);
  const access_token = crypto.randomBytes(32).toString("hex");
  accessTokens.add(access_token);
  console.log("Access token issued");
  res.json({ access_token, token_type: "bearer", expires_in: 86400 });
});

// ─── MCP Streamable HTTP Transport ───────────────────────────────────────────
const sessions = new Map();

app.post("/sse", async (req, res) => {
  console.log("MCP POST /sse received");
  const sessionId = req.headers["mcp-session-id"];

  let transport;
  if (sessionId && sessions.has(sessionId)) {
    transport = sessions.get(sessionId);
  } else {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        console.log(`MCP session initialized: ${id}`);
        sessions.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const server = createMCPServer();
    await server.connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
});

app.get("/sse", async (req, res) => {
  console.log("MCP GET /sse received");
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(400).json({ error: "No valid session ID" });
  }
  await sessions.get(sessionId).handleRequest(req, res);
});

app.delete("/sse", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && sessions.has(sessionId)) {
    sessions.get(sessionId).close();
    sessions.delete(sessionId);
  }
  res.status(200).end();
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", server: "qlm-mcp-server", version: "1.0.0" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`QLM MCP Server listening on port ${PORT}`);
  console.log(`Base URL: ${BASE_URL}`);
});
