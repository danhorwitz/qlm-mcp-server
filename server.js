import express from "express";
import crypto from "crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const QLM_BASE_URL = process.env.QLM_BASE_URL?.replace(/\/$/, "");
const QLM_VENDOR = process.env.QLM_VENDOR;
const QLM_PASSWORD = process.env.QLM_PASSWORD;
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : `http://localhost:${PORT}`;

if (!QLM_BASE_URL || !QLM_VENDOR || !QLM_PASSWORD) {
  console.error("Missing required env vars: QLM_BASE_URL, QLM_VENDOR, QLM_PASSWORD");
  process.exit(1);
}

// ─── Simple XML helpers (no dependencies) ────────────────────────────────────
function escapeXml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function extractXml(xml, tag) {
  const match = xml.match(new RegExp(`<(?:[^:]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[^:]+:)?${tag}>`, "i"));
  return match ? match[1].trim() : null;
}

function parseSoapResponse(xml, method) {
  const responseNode = extractXml(xml, `${method}Response`);
  if (!responseNode) return { raw: xml };
  const dataSet = extractXml(responseNode, "dataSet");
  const result = extractXml(responseNode, "result");
  if (dataSet) {
    try { return { data: JSON.parse(dataSet), result }; } catch { /* not JSON */ }
    return { dataSet, result };
  }
  return { result, raw: responseNode };
}

// ─── SOAP Request ─────────────────────────────────────────────────────────────
function buildSoap(method, params = {}) {
  const body = Object.entries(params)
    .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`).join("\n        ");
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <QlmSoapHeader xmlns="http://www.interactive-studios.net/qlmweb">
      <CultureName>en</CultureName>
      <User>${escapeXml(QLM_VENDOR)}</User>
      <Password>${escapeXml(QLM_PASSWORD)}</Password>
      <UtcOffset>0</UtcOffset>
    </QlmSoapHeader>
  </soap:Header>
  <soap:Body>
    <${method} xmlns="http://www.interactive-studios.net/qlmweb">
        ${body}
    </${method}>
  </soap:Body>
</soap:Envelope>`;
}

async function qlmSoap(method, params = {}) {
  const soapBody = buildSoap(method, params);
  console.log(`SOAP → ${method}`);
  const response = await fetch(QLM_BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "SOAPAction": `"http://www.interactive-studios.net/qlmweb/${method}"`,
    },
    body: soapBody,
  });
  const text = await response.text();
  console.log(`SOAP ← ${response.status} | ${text.slice(0, 400)}`);
  if (!response.ok) throw new Error(`SOAP ${response.status}: ${text.slice(0, 300)}`);
  return parseSoapResponse(text, method);
}

// ─── Tools ────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "get_license_info",
    description: "Look up full license details by activation key.",
    inputSchema: { type: "object", properties: { activation_key: { type: "string" } }, required: ["activation_key"] },
  },
  {
    name: "get_activation_status",
    description: "Check activation status for a license key — seats used, computers activated.",
    inputSchema: { type: "object", properties: { activation_key: { type: "string" } }, required: ["activation_key"] },
  },
  {
    name: "search_customers",
    description: "Search for customers by name, email, or company.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "get_customer_info_from_key",
    description: "Get customer info associated with a specific license activation key.",
    inputSchema: { type: "object", properties: { activation_key: { type: "string" } }, required: ["activation_key"] },
  },
  {
    name: "get_order",
    description: "Get details for a specific order by order ID.",
    inputSchema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
  },
  {
    name: "get_subscription_expiry",
    description: "Get the subscription expiry date for a license key.",
    inputSchema: { type: "object", properties: { activation_key: { type: "string" } }, required: ["activation_key"] },
  },
  {
    name: "get_all_licenses",
    description: "Get all licenses/customers in the system for generating the full report.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function callTool(name, args) {
  switch (name) {
    case "get_license_info":
      return qlmSoap("GetLicenseInfo", { is_activationkey: args.activation_key });
    case "get_activation_status":
      return qlmSoap("GetLicenseKeyInformation", { is_activationkey: args.activation_key });
    case "search_customers":
      return qlmSoap("GetCustomersInfo", {
        eFieldName: "", fieldOperator: "", fieldValue: args.query, dataSet: "",
      });
    case "get_customer_info_from_key":
      return qlmSoap("GetCustomerInfoFromActivationKey", { is_activationkey: args.activation_key });
    case "get_order":
      return qlmSoap("GetOrder", { is_orderid: args.order_id });
    case "get_subscription_expiry":
      return qlmSoap("GetSubscriptionExpiryDate", { is_activationkey: args.activation_key });
    case "get_all_licenses":
      return qlmSoap("GetCustomersInfo", { eFieldName: "", fieldOperator: "", fieldValue: "", dataSet: "" });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function createMCPServer() {
  const server = new Server({ name: "qlm-mcp-server", version: "1.0.0" }, { capabilities: { tools: {} } });
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

// ─── OAuth ────────────────────────────────────────────────────────────────────
const registeredClients = new Map();
const authCodes = new Map();
const accessTokens = new Set();

const app = express();
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/.well-known/oauth-protected-resource", (req, res) =>
  res.json({ resource: BASE_URL, authorization_servers: [BASE_URL] }));
app.get("/.well-known/oauth-authorization-server", (req, res) =>
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/oauth/authorize`,
    token_endpoint: `${BASE_URL}/oauth/token`,
    registration_endpoint: `${BASE_URL}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
  }));
app.post("/oauth/register", (req, res) => {
  const client_id = crypto.randomBytes(16).toString("hex");
  const client_secret = crypto.randomBytes(32).toString("hex");
  registeredClients.set(client_id, { client_id, client_secret, ...req.body });
  res.status(201).json({ client_id, client_secret, ...req.body });
});
app.get("/oauth/authorize", (req, res) => {
  const { redirect_uri, state, code_challenge, code_challenge_method, client_id } = req.query;
  const code = crypto.randomBytes(16).toString("hex");
  authCodes.set(code, { client_id, redirect_uri, code_challenge, code_challenge_method, expiresAt: Date.now() + 300000 });
  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  res.redirect(url.toString());
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
  res.json({ access_token, token_type: "bearer", expires_in: 86400 });
});

// ─── MCP Transport ────────────────────────────────────────────────────────────
const sessions = new Map();
app.post("/sse", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  let transport;
  if (sessionId && sessions.has(sessionId)) {
    transport = sessions.get(sessionId);
  } else {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => sessions.set(id, transport),
    });
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
    await createMCPServer().connect(transport);
  }
  await transport.handleRequest(req, res, req.body);
});
app.get("/sse", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !sessions.has(sessionId)) return res.status(400).json({ error: "No valid session" });
  await sessions.get(sessionId).handleRequest(req, res);
});
app.delete("/sse", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && sessions.has(sessionId)) { sessions.get(sessionId).close(); sessions.delete(sessionId); }
  res.status(200).end();
});
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, "0.0.0.0", () => console.log(`QLM MCP Server on port ${PORT} | ${BASE_URL}`));
