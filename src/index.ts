#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_BASE_URL, Tip4ServClient } from "./client.js";
import { createServer } from "./server.js";
import { loadOpenApiDocument, toolsFromOpenApi } from "./tools/openapi.js";
import type { ToolDefinition } from "./tools/types.js";

function envFlag(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[name] ?? "");
}

async function main(): Promise<void> {
  const apiKey = process.env.TIP4SERV_API_KEY?.trim();
  if (!apiKey) {
    // Still start so the client can list tools; calls report the missing key.
    console.error("[tip4serv-mcp] Warning: TIP4SERV_API_KEY is not set; API calls will fail until it is.");
  }
  const client = new Tip4ServClient({
    apiKey,
    baseUrl: process.env.TIP4SERV_API_BASE?.trim() || DEFAULT_BASE_URL,
  });

  let extraTools: ToolDefinition[] = [];
  const specSource = process.env.TIP4SERV_OPENAPI?.trim();
  if (specSource) {
    try {
      extraTools = toolsFromOpenApi(await loadOpenApiDocument(specSource));
      console.error(`[tip4serv-mcp] Loaded ${extraTools.length} tools from OpenAPI spec ${specSource}.`);
    } catch (error) {
      console.error(`[tip4serv-mcp] Could not load OpenAPI spec ${specSource}: ${error instanceof Error ? error.message : error}`);
    }
  }

  const server = createServer({ client, readOnly: envFlag("TIP4SERV_READ_ONLY"), extraTools });
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error("[tip4serv-mcp] Fatal error:", error);
  process.exit(1);
});
