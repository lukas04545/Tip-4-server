# tip4serv-mcp

An [MCP](https://modelcontextprotocol.io) server for managing a [Tip4Serv](https://tip4serv.com) store from Claude or any other MCP client: browse products and categories, create checkout links, and call any endpoint of the [Tip4Serv API](https://tip4serv.gitbook.io/tip4serv-api) (create or update products, discounts, customers, subscriptions, servers).

## Setup

```bash
npm install
npm run build
```

Create an API key in the Tip4Serv dashboard (**Store → API Keys**).

| Variable | Required | Purpose |
| --- | --- | --- |
| `TIP4SERV_API_KEY` | yes | Bearer token for the Tip4Serv API |
| `TIP4SERV_API_BASE` | no | API base URL (default `https://api.tip4serv.com/v1`) |
| `TIP4SERV_OPENAPI` | no | Path or URL of the Tip4Serv OpenAPI spec (JSON or YAML). Adds one typed tool per documented endpoint |
| `TIP4SERV_READ_ONLY` | no | `true` hides every tool that changes the store, and limits `tip4serv_api_request` to GET |

### Claude Code

```bash
claude mcp add tip4serv -e TIP4SERV_API_KEY=your_key -- node /path/to/Tip-4-server/dist/index.js
```

### Claude Desktop

```json
{
  "mcpServers": {
    "tip4serv": {
      "command": "node",
      "args": ["/path/to/Tip-4-server/dist/index.js"],
      "env": { "TIP4SERV_API_KEY": "your_key" }
    }
  }
}
```

### Over HTTP (supergateway)

```bash
npm install -g supergateway
TIP4SERV_API_KEY=your_key supergateway --stdio "node dist/index.js" --outputTransport streamableHttp --port 8000
# MCP endpoint: http://localhost:8000/mcp
```

The API key gives full control of the store. Don't expose this endpoint publicly without authentication in front of it.

## Tools

| Tool | What it does |
| --- | --- |
| `tip4serv_get_store` | Store info (`GET /store/whoami`) |
| `tip4serv_get_theme` | Store theme (`GET /store/theme`) |
| `tip4serv_list_categories` | Categories, paginated |
| `tip4serv_list_products` | Products, paginated, filterable by category; includes disabled products by default |
| `tip4serv_get_product` | One product by ID or slug, with full details |
| `tip4serv_get_checkout_identifiers` | Which customer identifiers a checkout for given products needs |
| `tip4serv_create_checkout_link` | Creates a checkout session and returns its payment URL |
| `tip4serv_api_request` | Calls any Tip4Serv API endpoint with any method |

### Typed tools for every endpoint

Download the OpenAPI spec from the [Tip4Serv API docs](https://tip4serv.gitbook.io/tip4serv-api) and point `TIP4SERV_OPENAPI` at it. The server then adds one tool per operation (for example creating or updating a product), with path and query parameters as arguments and the JSON body under `body`. Operations that change the store are marked as such, so clients can ask for confirmation.

Until then, product creation and other management actions go through `tip4serv_api_request`, using the paths from the API docs.
