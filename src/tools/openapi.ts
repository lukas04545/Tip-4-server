import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { HttpMethod } from "../client.js";
import { ToolInputError, type JsonSchema, type ToolDefinition } from "./types.js";

type OpenApiDocument = {
  openapi?: string;
  servers?: Array<{ url?: string }>;
  security?: unknown[];
  paths?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};

type Parameter = {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
};

type Operation = {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: unknown[];
  requestBody?: unknown;
  security?: unknown[];
  deprecated?: boolean;
};

const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const MAX_DESCRIPTION = 1000;
const MAX_SCHEMA_DEPTH = 12;
// OpenAPI-only keywords that are noise (or invalid) in a tool's JSON Schema.
const DROPPED_KEYS = new Set(["example", "examples", "xml", "externalDocs", "discriminator", "deprecated", "x-readme", "readOnly", "writeOnly"]);

/** Loads an OpenAPI 3 document (JSON or YAML) from a file path or an http(s) URL. */
export async function loadOpenApiDocument(source: string): Promise<OpenApiDocument> {
  const text = /^https?:\/\//i.test(source) ? await fetchText(source) : await readFile(source, "utf8");
  const document = parseYaml(text) as OpenApiDocument;
  if (!document || typeof document !== "object" || typeof document.paths !== "object") {
    throw new Error(`${source} is not an OpenAPI document (no "paths").`);
  }
  return document;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Fetching ${url} returned ${response.status}.`);
  return response.text();
}

/**
 * Builds one MCP tool per operation in the spec. Path and query parameters
 * become top-level arguments; the JSON request body goes under `body`.
 */
export function toolsFromOpenApi(document: OpenApiDocument, { namePrefix = "tip4serv_" }: { namePrefix?: string } = {}): ToolDefinition[] {
  const resolver = new RefResolver(document);
  const tools: ToolDefinition[] = [];
  const usedNames = new Set<string>();
  const serverPath = specServerPath(document);

  for (const [rawPath, pathItemRaw] of Object.entries(document.paths ?? {})) {
    const pathItem = resolver.resolve(pathItemRaw) as Record<string, unknown>;
    if (!pathItem || typeof pathItem !== "object") continue;
    const sharedParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];

    for (const method of METHODS) {
      const operation = resolver.resolve(pathItem[method.toLowerCase()]) as Operation | undefined;
      if (!operation || typeof operation !== "object") continue;

      const parameters = mergeParameters(resolver, sharedParameters, operation.parameters ?? []);
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const parameter of parameters) {
        if (parameter.in !== "path" && parameter.in !== "query") continue;
        const schema = resolver.toJsonSchema(parameter.schema ?? { type: "string" });
        properties[parameter.name] = parameter.description ? { ...schema, description: parameter.description } : schema;
        if (parameter.in === "path" || parameter.required) required.push(parameter.name);
      }

      const bodyKey = properties.body ? "request_body" : "body";
      const requestBody = resolver.resolve(operation.requestBody) as { required?: boolean; description?: string; content?: Record<string, { schema?: unknown }> } | undefined;
      let bodyNote = "";
      if (requestBody?.content) {
        const jsonContent = Object.entries(requestBody.content).find(([type]) => /json/i.test(type));
        const content = jsonContent?.[1] ?? Object.values(requestBody.content)[0];
        const schema = content?.schema ? resolver.toJsonSchema(content.schema) : { type: "object" };
        properties[bodyKey] = requestBody.description ? { ...schema, description: requestBody.description } : schema;
        if (requestBody.required) required.push(bodyKey);
        if (!jsonContent) bodyNote = ` The API documents a ${Object.keys(requestBody.content).join("/")} body for this endpoint; it is sent as JSON.`;
      }

      const parameterLocations = new Map(parameters.map((parameter) => [parameter.name, parameter.in]));
      const security = operation.security ?? document.security;
      const auth = !(Array.isArray(security) && security.length === 0);
      const requestPath = stripServerPath(rawPath, serverPath);
      const name = uniqueName(toolName(namePrefix, method, rawPath, operation.operationId), usedNames);
      const readOnly = method === "GET";

      tools.push({
        name,
        description: describe(method, rawPath, operation) + bodyNote,
        inputSchema: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false },
        annotations: {
          title: operation.summary ?? `${method} ${rawPath}`,
          readOnlyHint: readOnly,
          destructiveHint: method === "DELETE" || method === "PUT" || method === "PATCH",
          idempotentHint: method !== "POST",
          openWorldHint: true,
        },
        readOnly,
        handler: async (args, { client }) => {
          for (const key of required) {
            if (args[key] === undefined || args[key] === null || args[key] === "") throw new ToolInputError(`"${key}" is required.`);
          }
          const query: Record<string, unknown> = {};
          let path = requestPath;
          for (const [key, value] of Object.entries(args)) {
            if (key === bodyKey || value === undefined) continue;
            const location = parameterLocations.get(key);
            if (location === "path") {
              path = path.split(`{${key}}`).join(encodeURIComponent(String(value)));
            } else if (location === "query") {
              query[key] = value;
            } else {
              throw new ToolInputError(`Unknown argument "${key}".`);
            }
          }
          return client.request({ method, path, query: query as Record<string, string>, body: args[bodyKey], auth });
        },
      });
    }
  }
  return tools;
}

function mergeParameters(resolver: RefResolver, shared: unknown[], own: unknown[]): Parameter[] {
  const merged = new Map<string, Parameter>();
  for (const raw of [...shared, ...own]) {
    const parameter = resolver.resolve(raw) as Parameter;
    if (parameter && typeof parameter.name === "string" && typeof parameter.in === "string") {
      merged.set(`${parameter.in}:${parameter.name}`, parameter);
    }
  }
  return [...merged.values()];
}

function describe(method: HttpMethod, path: string, operation: Operation): string {
  const parts = [operation.summary, operation.description].filter((part): part is string => typeof part === "string" && part.trim() !== "");
  const unique = parts.filter((part, index) => parts.indexOf(part) === index);
  let text = unique.join("\n\n").trim();
  if (text.length > MAX_DESCRIPTION) text = text.slice(0, MAX_DESCRIPTION - 1) + "…";
  const tags = operation.tags?.length ? ` [${operation.tags.join(", ")}]` : "";
  const warning = method === "GET" ? "" : " Changes the live store: confirm with the user first.";
  const deprecated = operation.deprecated ? " Deprecated." : "";
  return `${text ? text + "\n\n" : ""}${method} ${path}${tags}.${deprecated}${warning}`;
}

function toolName(prefix: string, method: HttpMethod, path: string, operationId?: string): string {
  const base = operationId
    ? operationId
    : `${method}_${path.replace(/\{([^}]+)\}/g, "by_$1")}`;
  const snake = base
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return (prefix + snake).slice(0, 60);
}

function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  for (let index = 2; used.has(candidate); index++) candidate = `${name.slice(0, 57)}_${index}`;
  used.add(candidate);
  return candidate;
}

/** The path part of the spec's server URL, e.g. "/v1" for "https://api.tip4serv.com/v1". */
function specServerPath(document: OpenApiDocument): string {
  const url = document.servers?.[0]?.url;
  if (!url) return "";
  try {
    return new URL(url, "https://placeholder.invalid").pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/**
 * The client already targets the versioned base URL. If the spec's server URL
 * has no version prefix but its paths do ("/v1/store/..."), drop that prefix.
 */
function stripServerPath(path: string, serverPath: string): string {
  if (serverPath === "" && /^\/v\d+\//.test(path)) return path.replace(/^\/v\d+/, "");
  return path;
}

class RefResolver {
  constructor(private readonly document: OpenApiDocument) {}

  /** Follows a local "$ref" chain to the referenced object. */
  resolve(value: unknown, seen = new Set<string>()): unknown {
    if (!value || typeof value !== "object" || !("$ref" in value)) return value;
    const ref = (value as { $ref: unknown }).$ref;
    if (typeof ref !== "string" || !ref.startsWith("#/") || seen.has(ref)) return {};
    seen.add(ref);
    let target: unknown = this.document;
    for (const segment of ref.slice(2).split("/")) {
      const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
      target = target && typeof target === "object" ? (target as Record<string, unknown>)[key] : undefined;
    }
    return this.resolve(target, seen);
  }

  /** Inlines all local refs into a self-contained JSON Schema, cutting cycles. */
  toJsonSchema(schema: unknown, depth = 0, stack: string[] = []): JsonSchema {
    if (!schema || typeof schema !== "object") return {};
    if (Array.isArray(schema)) return {};
    const ref = (schema as { $ref?: unknown }).$ref;
    if (typeof ref === "string") {
      if (stack.includes(ref) || depth > MAX_SCHEMA_DEPTH) return { type: "object", description: "(recursive structure)" };
      return this.toJsonSchema(this.resolve(schema), depth + 1, [...stack, ref]);
    }
    if (depth > MAX_SCHEMA_DEPTH) return {};

    const result: JsonSchema = {};
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (DROPPED_KEYS.has(key) || key.startsWith("x-")) continue;
      if (key === "properties" && value && typeof value === "object") {
        const properties: Record<string, JsonSchema> = {};
        for (const [name, property] of Object.entries(value as Record<string, unknown>)) {
          // Server-generated fields (id, created_date…) are not inputs.
          if ((this.resolve(property) as { readOnly?: boolean })?.readOnly) continue;
          properties[name] = this.toJsonSchema(property, depth + 1, stack);
        }
        result.properties = properties;
      } else if ((key === "items" || key === "additionalProperties" || key === "not") && value && typeof value === "object") {
        result[key] = this.toJsonSchema(value, depth + 1, stack);
      } else if ((key === "allOf" || key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
        result[key] = value.map((entry) => this.toJsonSchema(entry, depth + 1, stack));
      } else {
        result[key] = value;
      }
    }
    // OpenAPI 3.0 `nullable` → JSON Schema type union.
    if (result.nullable === true) {
      delete result.nullable;
      if (typeof result.type === "string") result.type = [result.type, "null"];
    }
    if (Array.isArray(result.required) && result.properties) {
      const properties = result.properties as Record<string, unknown>;
      result.required = (result.required as string[]).filter((name) => name in properties);
      if ((result.required as string[]).length === 0) delete result.required;
    }
    return result;
  }
}
