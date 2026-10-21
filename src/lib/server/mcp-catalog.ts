import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpFetch, safePublicUrl, SafeFetchError } from "./safe-http";

type CatalogInput = {
  query?: string;
  filters?: { categories?: string[]; price?: { min?: number; max?: number } };
  context?: { currency: string };
  pagination: { limit: number; cursor?: string };
};
type Failure =
  | "mcp_tool_unavailable"
  | "mcp_incompatible_tool"
  | "mcp_invalid_response"
  | "mcp_tool_error"
  | "mcp_request_failed";
export class McpCatalogError extends Error {
  constructor(public readonly code: Failure) {
    super("The merchant MCP catalog request could not be completed.");
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** No merchant instructions, output schemas, or arbitrary tool names reach GPT. */
export async function searchMcpCatalog(
  endpoint: string,
  platformProfileUrl: string,
  catalog: CatalogInput,
  externalSignal: AbortSignal,
  dependencies: { createFetch?: typeof createMcpFetch } = {}
): Promise<unknown> {
  const url = safePublicUrl(endpoint);
  if (url.search) {
    throw new SafeFetchError("unsafe_url");
  }
  const profile = safePublicUrl(platformProfileUrl);
  if (profile.search) {
    throw new SafeFetchError("unsafe_url");
  }
  const signal = AbortSignal.any([externalSignal, AbortSignal.timeout(30_000)]);
  const safeFetch = (dependencies.createFetch ?? createMcpFetch)(url.href, profile.href, signal);
  const meta = { "ucp-agent": { profile: profile.href } };
  let posts = 0;
  const fetchWithMetadata: typeof fetch = async (input, init) => {
    if (init?.method === "POST") {
      if (++posts > 6 || typeof init.body !== "string") {
        throw new SafeFetchError("invalid_request");
      }
      const message: unknown = JSON.parse(init.body);
      if (
        !object(message) ||
        !["initialize", "notifications/initialized", "tools/list", "tools/call"].includes(
          String(message.method)
        )
      ) {
        throw new SafeFetchError("invalid_request");
      }
      const params = object(message.params) ? message.params : {};
      const args = object(params.arguments) ? params.arguments : {};
      if (message.method === "tools/call" && params.name !== "search_catalog") {
        throw new SafeFetchError("invalid_request");
      }
      // Shopify tools/list also requires arguments.meta. This is UCP metadata,
      // not MCP's unrelated params._meta. Include it during initialization too.
      const body = JSON.stringify({
        ...message,
        params: { ...params, arguments: { ...args, meta } },
      });
      return safeFetch(input, { ...init, body });
    }
    return safeFetch(input, init);
  };
  const client = new Client({ name: "hashtrion-agent-ai", version: "0.1.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: fetchWithMetadata,
    requestInit: { redirect: "error" },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1_000,
      maxReconnectionDelay: 1_000,
      reconnectionDelayGrowFactor: 1,
    },
  });
  const requestOptions = { signal, timeout: 7_000, maxTotalTimeout: 7_000 };
  try {
    await client.connect(transport, requestOptions);
    let cursor: string | undefined;
    const seen = new Set<string>();
    let found = false;
    for (let page = 0; page < 3; page++) {
      // Use the SDK envelope validator without compiling merchant-controlled
      // JSON Schemas. Only our reviewed UCP parser validates product output.
      const listed = await client.request(
        { method: "tools/list", params: { ...(cursor ? { cursor } : {}), arguments: { meta } } },
        ListToolsResultSchema,
        requestOptions
      );
      if (listed.tools.length > 100) {
        throw new McpCatalogError("mcp_invalid_response");
      }
      const matches = listed.tools.filter((tool) => tool.name === "search_catalog");
      if (matches.length > 1) {
        throw new McpCatalogError("mcp_invalid_response");
      }
      if (matches.length === 1) {
        const tool = matches[0];
        const properties = tool.inputSchema.properties;
        const required = tool.inputSchema.required ?? [];
        if (
          tool.annotations?.readOnlyHint === false ||
          tool.execution?.taskSupport === "required" ||
          !object(properties) ||
          !object(properties.catalog) ||
          !object(properties.meta) ||
          (properties.catalog.type !== undefined && properties.catalog.type !== "object") ||
          (properties.meta.type !== undefined && properties.meta.type !== "object") ||
          !Array.isArray(required) ||
          required.some((key) => key !== "catalog" && key !== "meta")
        ) {
          throw new McpCatalogError("mcp_incompatible_tool");
        }
        found = true;
        break;
      }
      const next = listed.nextCursor;
      if (!next) {
        break;
      }
      if (next.length > 2_048 || seen.has(next)) {
        throw new McpCatalogError("mcp_invalid_response");
      }
      seen.add(next);
      cursor = next;
    }
    if (!found) {
      throw new McpCatalogError("mcp_tool_unavailable");
    }
    const result = await client.callTool(
      { name: "search_catalog", arguments: { meta, catalog } },
      undefined,
      requestOptions
    );
    if (result.isError) {
      throw new McpCatalogError("mcp_tool_error");
    }
    if (object(result.structuredContent)) {
      return result.structuredContent;
    }
    // MCP permits a JSON text representation. Never scrape prose, concatenate
    // blocks, dereference resource links, or manufacture a successful result.
    if (
      Array.isArray(result.content) &&
      result.content.length === 1 &&
      result.content[0].type === "text" &&
      typeof result.content[0].text === "string" &&
      Buffer.byteLength(result.content[0].text) <= 128 * 1024
    ) {
      try {
        return JSON.parse(result.content[0].text);
      } catch {
        /* fail closed */
      }
    }
    throw new McpCatalogError("mcp_invalid_response");
  } catch (error) {
    if (error instanceof McpCatalogError || error instanceof SafeFetchError) {
      throw error;
    }
    throw new McpCatalogError("mcp_request_failed");
  } finally {
    // No persistent session, server-initiated tools, auth flow, or retry loop.
    await client.close().catch(() => {});
  }
}
