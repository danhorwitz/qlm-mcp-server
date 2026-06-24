# QLM MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that connects Claude to your Quick License Manager instance via its REST API.

## Tools exposed to Claude

| Tool | What it does |
|------|-------------|
| `get_license_info` | Full details for a license key (product, seats, expiry, maintenance) |
| `get_activation_status` | Which machines have the license activated, seats used vs. available |
| `search_customers` | Search customers by name, email, or company |
| `get_customer_orders` | All orders for a customer email |
| `get_order` | Details for a specific order ID |

---

## Deployment (Render — recommended)

1. Push this folder to a GitHub repo.
2. Go to [render.com](https://render.com) → New → Web Service → connect your repo.
3. Set the following:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Under **Environment Variables**, add:
   - `QLM_BASE_URL` — e.g. `https://yourserver.com/qlmwebservice/qlmservice.asmx`
   - `QLM_VENDOR` — your QLM vendor username
   - `QLM_PASSWORD` — your QLM API password
5. Deploy. Note the public HTTPS URL Render gives you (e.g. `https://qlm-mcp-server.onrender.com`).

---

## Connecting to Claude.ai

1. Go to **Claude.ai → Settings → Integrations** (or Connectors).
2. Add a custom MCP connector.
3. Set the URL to: `https://your-render-url.onrender.com/sse`
4. Save and authorize.

---

## Adjusting QLM endpoint names

QLM endpoint names can vary slightly between versions. If a tool returns an error, check your QLM documentation and update the method name in the `callTool` switch in `server.js`.

For example, if your version uses `GetLicenseDetails` instead of `GetLicenseInfo`:

```js
case "get_license_info":
  return qlmRequest("GetLicenseDetails", { ... });
```

---

## Local testing

```bash
cp .env.example .env
# Fill in your values in .env
npm install
npm run dev
```

Then point a local MCP client at `http://localhost:3000/sse`.
