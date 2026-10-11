import type { HttpMethod, Tip4ServClient } from "../client.js";
import { compact, optionalBoolean, optionalInteger, optionalObject, optionalString, requiredArray } from "./args.js";
import { ToolInputError, type ToolDefinition } from "./types.js";

const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const paginationProperties = {
  page: { type: "integer", minimum: 1, description: "Page number, starting at 1." },
  max_page: { type: "integer", minimum: 1, description: "Items per page (the storefront example uses 50)." },
};

const storeIdProperty = {
  type: "integer",
  description: "Store ID. Defaults to the store that owns the API key (from tip4serv_get_store).",
};

const storeIdCache = new WeakMap<Tip4ServClient, Promise<number>>();

/** Resolves the store ID, looking it up once per client via /store/whoami when not given. */
async function resolveStoreId(client: Tip4ServClient, args: Record<string, unknown>): Promise<number> {
  const explicit = optionalInteger(args, "store_id", { min: 1 });
  if (explicit !== undefined) return explicit;
  let lookup = storeIdCache.get(client);
  if (!lookup) {
    lookup = client.request<{ id?: unknown }>({ path: "/store/whoami" }).then((store) => {
      if (typeof store?.id !== "number") throw new Error("Could not determine the store ID from /store/whoami; pass store_id explicitly.");
      return store.id;
    });
    lookup.catch(() => storeIdCache.delete(client));
    storeIdCache.set(client, lookup);
  }
  return lookup;
}

function productIdList(args: Record<string, unknown>, key: string): number[] {
  return requiredArray(args, key).map((value) => {
    if (typeof value !== "number" || !Number.isInteger(value)) throw new ToolInputError(`"${key}" must contain integer product IDs.`);
    return value;
  });
}

export const builtinTools: ToolDefinition[] = [
  {
    name: "tip4serv_get_store",
    description: "Get the Tip4Serv store that owns the API key: ID, title, description, domain, currency, timezone, social links and menu links.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "Get store info", readOnlyHint: true, openWorldHint: true },
    readOnly: true,
    handler: (_args, { client }) => client.request({ path: "/store/whoami" }),
  },
  {
    name: "tip4serv_get_theme",
    description: "Get the store theme: name, slugs, light/dark images, mode and widget settings.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "Get store theme", readOnlyHint: true, openWorldHint: true },
    readOnly: true,
    handler: (_args, { client }) => client.request({ path: "/store/theme" }),
  },
  {
    name: "tip4serv_list_categories",
    description: "List store categories (id, name, slug, hidden flag, parent, description, image). Returns { categories, categories_count }.",
    inputSchema: {
      type: "object",
      properties: {
        ...paginationProperties,
        parent: { type: "integer", description: "Only return sub-categories of this parent category ID." },
      },
      additionalProperties: false,
    },
    annotations: { title: "List categories", readOnlyHint: true, openWorldHint: true },
    readOnly: true,
    handler: (args, { client }) =>
      client.request({
        path: "/store/categories",
        query: compact({
          page: optionalInteger(args, "page", { min: 1 }) ?? 1,
          max_page: optionalInteger(args, "max_page", { min: 1 }) ?? 50,
          parent: optionalInteger(args, "parent"),
        }),
      }),
  },
  {
    name: "tip4serv_list_products",
    description:
      "List store products (id, name, status, slug, price, old_price, category, subscription settings, stock, featured, image). " +
      "Returns { products, product_count }. Set only_enabled=false to include disabled products.",
    inputSchema: {
      type: "object",
      properties: {
        ...paginationProperties,
        details: { type: "boolean", description: "Include full product details (description, custom fields, server options…). Default false." },
        only_enabled: { type: "boolean", description: "Only return enabled products. Default false, so disabled products are listed too." },
        category: { type: "integer", description: "Only return products in this category ID." },
      },
      additionalProperties: false,
    },
    annotations: { title: "List products", readOnlyHint: true, openWorldHint: true },
    readOnly: true,
    handler: (args, { client }) =>
      client.request({
        path: "/store/products",
        query: compact({
          page: optionalInteger(args, "page", { min: 1 }) ?? 1,
          max_page: optionalInteger(args, "max_page", { min: 1 }) ?? 50,
          details: optionalBoolean(args, "details") ?? false,
          only_enabled: optionalBoolean(args, "only_enabled") ?? false,
          category: optionalInteger(args, "category"),
        }),
      }),
  },
  {
    name: "tip4serv_get_product",
    description: "Get one product by ID or slug, including (by default) full details: description, gallery, custom fields and rules, server options, stock, subscription and donation settings.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Product ID. Give either id or slug." },
        slug: { type: "string", description: "Product slug. Give either id or slug." },
        details: { type: "boolean", description: "Include full product details. Default true." },
      },
      additionalProperties: false,
    },
    annotations: { title: "Get product", readOnlyHint: true, openWorldHint: true },
    readOnly: true,
    handler: (args, { client }) => {
      const id = optionalInteger(args, "id");
      const slug = optionalString(args, "slug");
      if ((id === undefined) === (slug === undefined)) throw new ToolInputError('Give exactly one of "id" or "slug".');
      const path = id !== undefined ? `/store/product/${id}` : `/store/product/slug/${encodeURIComponent(slug!)}`;
      return client.request({ path, query: { details: optionalBoolean(args, "details") ?? true } });
    },
  },
  {
    name: "tip4serv_get_checkout_identifiers",
    description: "List which customer identifiers (e.g. email, minecraft_username, steam_id, discord_id) a checkout for the given products requires.",
    inputSchema: {
      type: "object",
      properties: {
        product_ids: { type: "array", items: { type: "integer" }, minItems: 1, description: "Product IDs that will be in the checkout." },
        store_id: storeIdProperty,
      },
      required: ["product_ids"],
      additionalProperties: false,
    },
    annotations: { title: "Get checkout identifiers", readOnlyHint: true, openWorldHint: true },
    readOnly: true,
    handler: async (args, { client }) => {
      const products = productIdList(args, "product_ids");
      const store = await resolveStoreId(client, args);
      return client.request({ path: "/store/checkout/identifiers", query: { store, products }, auth: false });
    },
  },
  {
    name: "tip4serv_create_checkout_link",
    description:
      "Create a checkout session for one or more products and return its payment URL ({ url }). " +
      "Without a user, the customer enters their details on the Tip4Serv checkout page; use tip4serv_get_checkout_identifiers to see which user fields are required when passing one.",
    inputSchema: {
      type: "object",
      properties: {
        products: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              product_id: { type: "integer" },
              type: { type: "string", enum: ["addtocart", "subscribe"], description: '"subscribe" for a recurring subscription, otherwise "addtocart".' },
              quantity: { type: "integer", minimum: 1 },
              donation_amount: { type: "number", description: "Amount for donation products." },
              server_selection: { type: "integer", description: "Server ID, for products that let the buyer choose a server." },
              custom_fields: { type: "object", description: "Custom field values keyed by custom field ID.", additionalProperties: true },
            },
            required: ["product_id", "type", "quantity"],
          },
        },
        user: {
          type: "object",
          description: "Customer identifiers. email is required when a user is given.",
          properties: {
            email: { type: "string" },
            username: { type: "string" },
            minecraft_username: { type: "string" },
            minecraft_uuid: { type: "string" },
            steam_id: { type: "string" },
            discord_id: { type: "string" },
            epic_id: { type: "string" },
            eos_id: { type: "string" },
            fivem_citizen_id: { type: "string" },
            ingame_username: { type: "string" },
            rust_username: { type: "string" },
          },
          required: ["email"],
          additionalProperties: true,
        },
        redirect_success_checkout: { type: "string", description: "URL to send the customer to after a successful payment." },
        redirect_canceled_checkout: { type: "string", description: "URL to send the customer to if they cancel." },
        redirect_pending_checkout: { type: "string", description: "URL to send the customer to while the payment is pending." },
        store_id: storeIdProperty,
      },
      required: ["products"],
      additionalProperties: false,
    },
    annotations: { title: "Create checkout link", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    readOnly: false,
    handler: async (args, { client }) => {
      const products = requiredArray(args, "products");
      const user = optionalObject(args, "user");
      if (user && typeof user.email !== "string") throw new ToolInputError('"user.email" is required when "user" is given.');
      const store = await resolveStoreId(client, args);
      return client.request({
        method: "POST",
        path: "/store/checkout",
        query: { store },
        body: compact({
          products,
          user,
          redirect_success_checkout: optionalString(args, "redirect_success_checkout"),
          redirect_canceled_checkout: optionalString(args, "redirect_canceled_checkout"),
          redirect_pending_checkout: optionalString(args, "redirect_pending_checkout"),
        }),
      });
    },
  },
  {
    name: "tip4serv_api_request",
    description:
      "Call any Tip4Serv API endpoint (https://tip4serv.gitbook.io/tip4serv-api), e.g. to create or update products, manage discounts and coupons, " +
      "customers, subscriptions, payments or servers. The path is relative to https://api.tip4serv.com/v1 (e.g. \"/store/products\"). " +
      "Prefer the dedicated tools when one exists. POST/PUT/PATCH/DELETE change the live store, so confirm with the user first.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: HTTP_METHODS, description: "HTTP method. Default GET." },
        path: { type: "string", description: 'Endpoint path starting with "/", relative to the API base URL.' },
        query: { type: "object", description: "Query string parameters. Arrays and objects are sent as JSON strings.", additionalProperties: true },
        body: { description: "JSON request body for POST/PUT/PATCH/DELETE." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { title: "Tip4Serv API request", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    // Listed in read-only mode too, where it only allows GET.
    readOnly: true,
    handler: (args, { client, readOnly }) => {
      const rawMethod = (optionalString(args, "method") ?? "GET").toUpperCase();
      if (!HTTP_METHODS.includes(rawMethod as HttpMethod)) throw new ToolInputError(`"method" must be one of ${HTTP_METHODS.join(", ")}.`);
      const method = rawMethod as HttpMethod;
      if (readOnly && method !== "GET") throw new ToolInputError(`The server is in read-only mode (TIP4SERV_READ_ONLY), so ${method} requests are disabled.`);
      const path = optionalString(args, "path");
      if (!path) throw new ToolInputError('"path" is required.');
      return client.request({ method, path, query: optionalObject(args, "query") as Record<string, string> | undefined, body: args.body });
    },
  },
];
