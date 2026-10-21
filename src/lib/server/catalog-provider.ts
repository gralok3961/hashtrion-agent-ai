import type { CatalogReport } from "../catalog-types";
import { parseCatalogResponse, validCatalogSearch, type CatalogOptions } from "./catalog";
import { McpCatalogError, searchMcpCatalog } from "./mcp-catalog";
import { CATALOG_VERSION, verifyPlatformProfile } from "./platform-profile";
import { fetchPublicJson, safePublicUrl, SafeFetchError } from "./safe-http";
import {
  getCatalogProvider,
  SHOPIFY_GLOBAL_PROVIDER,
  type CatalogProvider,
} from "./catalog-provider-registry";

export { SHOPIFY_GLOBAL_PROVIDER } from "./catalog-provider-registry";

type Dependencies = { fetchProfile?: typeof fetchPublicJson; mcp?: typeof searchMcpCatalog };

/** Share the verified platform identity, SSRF boundary and parser with merchant MCP. */
export async function providerCatalogSearch(
  provider: CatalogProvider,
  query: string,
  options: CatalogOptions,
  dependencies: Dependencies = {}
): Promise<CatalogReport> {
  const registered = provider ? getCatalogProvider(provider.id) : undefined;
  // Failure reports contain only known infrastructure, never attacker input.
  const trustedProvider =
    registered && registered === provider ? registered : SHOPIFY_GLOBAL_PROVIDER;
  const endpoint = new URL(trustedProvider.endpoint);
  const report: CatalogReport = {
    provider: trustedProvider.id,
    status: "request_failed",
    merchantDomain: endpoint.hostname,
    query,
    products: [],
    messages: [],
    ...(options.filters ? { filters: options.filters } : {}),
    ...(options.context ? { context: options.context } : {}),
    diagnostics: {
      profileUrl: trustedProvider.documentation,
      endpoint: endpoint.href,
      transport: "mcp",
      version: CATALOG_VERSION,
    },
  };
  // Even internal callers cannot substitute an arbitrary provider or endpoint.
  if (!registered || registered !== provider) {
    return {
      ...report,
      diagnostics: { ...report.diagnostics, reason: "invalid_catalog_provider" },
    };
  }
  if (
    !validCatalogSearch(query, options.filters, options.context) ||
    (options.cursor !== undefined &&
      (typeof options.cursor !== "string" ||
        !options.cursor.length ||
        options.cursor.length > 2048 ||
        /[\u0000-\u001f\u007f]/u.test(options.cursor)))
  ) {
    return { ...report, diagnostics: { ...report.diagnostics, reason: "invalid_search_input" } };
  }
  const rawProfile = options.platformProfileUrl ?? process.env.UCP_PLATFORM_PROFILE_URL;
  // Only disclose a valid public profile URL. Invalid config can contain private
  // hosts or credentials; the documentation link is diagnostics, not a profile.
  try {
    if (rawProfile) {
      const url = safePublicUrl(rawProfile);
      if (url.pathname === "/.well-known/ucp" && !url.search) {
        report.diagnostics.profileUrl = url.href;
      }
    }
  } catch {
    /* verifyPlatformProfile returns a fixed, safe failure reason. */
  }
  const identity = await verifyPlatformProfile(
    rawProfile,
    [endpoint.origin],
    options.signal,
    dependencies.fetchProfile ?? fetchPublicJson
  );
  if (!identity.ok) {
    return {
      ...report,
      status: "platform_unavailable",
      diagnostics: { ...report.diagnostics, reason: identity.reason },
    };
  }
  report.diagnostics.profileUrl = identity.url;
  const search = {
    ...(query.trim() ? { query: query.trim() } : {}),
    ...(options.filters ? { filters: options.filters } : {}),
    ...(options.context ? { context: options.context } : {}),
    pagination: { limit: 3, ...(options.cursor ? { cursor: options.cursor } : {}) },
  };
  try {
    const body = await (dependencies.mcp ?? searchMcpCatalog)(
      endpoint.href,
      identity.url,
      search,
      options.signal
    );
    try {
      const parsed = parseCatalogResponse(body);
      return {
        ...report,
        status: parsed.applicationError ? "merchant_error" : "completed",
        products: parsed.products,
        messages: parsed.messages,
        ...(parsed.pagination ? { pagination: parsed.pagination } : {}),
      };
    } catch {
      return {
        ...report,
        status: "invalid_response",
        diagnostics: { ...report.diagnostics, reason: "invalid_catalog_response" },
      };
    }
  } catch (error) {
    if (error instanceof McpCatalogError) {
      const status =
        error.code === "mcp_tool_error"
          ? "merchant_error"
          : error.code === "mcp_invalid_response"
            ? "invalid_response"
            : error.code === "mcp_incompatible_tool" || error.code === "mcp_tool_unavailable"
              ? "unsupported"
              : "request_failed";
      return { ...report, status, diagnostics: { ...report.diagnostics, reason: error.code } };
    }
    return {
      ...report,
      diagnostics: {
        ...report.diagnostics,
        reason: error instanceof SafeFetchError ? error.code : "network_error",
      },
    };
  }
}
