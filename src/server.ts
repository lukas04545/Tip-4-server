import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Tip4ServApiError, type Tip4ServClient } from "./client.js";
import { builtinTools } from "./tools/builtin.js";
import type { ToolDefinition } from "./tools/types.js";

export const SERVER_NAME = "tip4serv-mcp";
export const SERVER_VERSION = "0.1.0";

const MAX_OUTPUT_CHARS = 100_000;

export interface ServerOptions {
  client: Tip4ServClient;
  readOnly?: boolean;
  /** Extra tools (e.g. generated from the OpenAPI spec). On a name clash they replace the built-in tool. */
  extraTools?: ToolDefinition[];
}

export function selectTools({ readOnly = false, extraTools = [] }: Omit<ServerOptions, "client">): ToolDefinition[] {
  const byName = new Map<string, ToolDefinition>();
  for (const tool of [...builtinTools, ...extraTools]) byName.set(tool.name, tool);
  return [...byName.values()].filter((tool) => !readOnly || tool.readOnly);
}

export function createServer(options: ServerOptions): Server {
  const readOnly = options.readOnly ?? false;
  const tools = selectTools(options);
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Tools for managing a Tip4Serv store (https://tip4serv.com). Start with tip4serv_get_store to see which store the key belongs to. " +
        "Tools that create, update or delete things act on the live store: confirm the exact change with the user before calling them." +
        (readOnly ? " This server is in read-only mode: only read operations are available." : ""),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const tool = toolsByName.get(request.params.name);
    if (!tool) return errorResult(`Unknown tool "${request.params.name}".`);
    try {
      const result = await tool.handler(request.params.arguments ?? {}, { client: options.client, readOnly });
      return { content: [{ type: "text", text: formatOutput(result) }] };
    } catch (error) {
      return errorResult(describeError(error));
    }
  });

  return server;
}

function formatOutput(result: unknown): string {
  const text = result === null || result === undefined ? "OK (empty response)" : typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated ${text.length - MAX_OUTPUT_CHARS} characters; use pagination to fetch less)` : text;
}

function describeError(error: unknown): string {
  if (error instanceof Tip4ServApiError) {
    if (error.status === 401 || error.status === 403) {
      return `${error.message}\nCheck that TIP4SERV_API_KEY is valid and has access to this resource (Tip4Serv dashboard → Store → API Keys).`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}
