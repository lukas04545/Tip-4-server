import type { Tip4ServClient } from "../client.js";

export type JsonSchema = Record<string, unknown>;

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolContext {
  client: Tip4ServClient;
  /** When true, only read-only operations may run. */
  readOnly: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema & { type: "object" };
  annotations: ToolAnnotations;
  /** True when the tool never changes anything in the store. Non read-only tools are hidden in read-only mode. */
  readOnly: boolean;
  handler(args: Record<string, unknown>, context: ToolContext): Promise<unknown>;
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}
