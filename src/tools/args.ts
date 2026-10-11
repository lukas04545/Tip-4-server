import { ToolInputError } from "./types.js";

type Args = Record<string, unknown>;

export function optionalString(args: Args, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ToolInputError(`"${key}" must be a string.`);
  return value;
}

export function optionalInteger(args: Args, key: string, { min }: { min?: number } = {}): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isInteger(number)) throw new ToolInputError(`"${key}" must be an integer.`);
  if (min !== undefined && number < min) throw new ToolInputError(`"${key}" must be >= ${min}.`);
  return number;
}

export function optionalBoolean(args: Args, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (value === "true" || value === "false") return value === "true";
  if (typeof value !== "boolean") throw new ToolInputError(`"${key}" must be a boolean.`);
  return value;
}

export function optionalObject(args: Args, key: string): Record<string, unknown> | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new ToolInputError(`"${key}" must be an object.`);
  return value as Record<string, unknown>;
}

export function requiredArray(args: Args, key: string): unknown[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length === 0) throw new ToolInputError(`"${key}" must be a non-empty array.`);
  return value;
}

/** Drops keys whose value is undefined so they are not sent to the API. */
export function compact<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as Partial<T>;
}
