import { randomUUID } from "node:crypto";
import type {
  CatalogFilters,
  CatalogImage,
  CatalogMessage,
  CatalogPrice,
  CatalogProduct,
  CatalogReport,
  CatalogVariant,
} from "../catalog-types";
import type { MerchantResult } from "../discovery-types";
import { fetchPublicJson, postPublicJson, safePublicUrl, SafeFetchError } from "./safe-http";
import {
  CATALOG_CAPABILITY,
  CATALOG_VERSION,
  SHOPPING_SERVICE,
  createPlatformProfile,
  verifyPlatformProfile,
} from "./platform-profile";
import { McpCatalogError, searchMcpCatalog } from "./mcp-catalog";

export type VerifiedMerchant = Extract<MerchantResult, { status: "verified" }>;
export type CatalogOptions = {
  signal: AbortSignal;
  cursor?: string;
  platformProfileUrl?: string;
  filters?: CatalogFilters;
  context?: { currency: string };
};

/** Only the standard, bounded search filters are supported; no arbitrary extensions. */
export function validCatalogSearch(query: unknown, filters?: unknown, context?: unknown): boolean {
  if (typeof query !== "string" || query.length > 500 || /[\u0000-\u001f\u007f]/u.test(query)) {
    return false;
  }
  let hasFilter = false;
  if (filters !== undefined) {
    if (!filters || typeof filters !== "object" || Array.isArray(filters)) {
      return false;
    }
    const f = filters as Record<string, unknown>;
    if (Object.keys(f).some((key) => !["categories", "price"].includes(key))) {
      return false;
    }
    if (f.categories !== undefined) {
      if (
        !Array.isArray(f.categories) ||
        !f.categories.length ||
        f.categories.length > 10 ||
        f.categories.some(
          (value) =>
            typeof value !== "string" ||
            !value.trim() ||
            value.length > 100 ||
            /[\u0000-\u001f\u007f]/u.test(value)
        )
      ) {
        return false;
      }
      hasFilter = true;
    }
    if (f.price !== undefined) {
      if (!f.price || typeof f.price !== "object" || Array.isArray(f.price)) {
        return false;
      }
      const price = f.price as Record<string, unknown>;
      if (
        Object.keys(price).some((key) => !["min", "max"].includes(key)) ||
        (price.min === undefined && price.max === undefined)
      ) {
        return false;
      }
      for (const value of [price.min, price.max]) {
        if (
          value !== undefined &&
          (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
        ) {
          return false;
        }
      }
      if (typeof price.min === "number" && typeof price.max === "number" && price.min > price.max) {
        return false;
      }
      hasFilter = true;
    }
    if (!hasFilter) {
      return false;
    }
  }
  if (context !== undefined) {
    if (!context || typeof context !== "object" || Array.isArray(context)) {
      return false;
    }
    const c = context as Record<string, unknown>;
    if (
      Object.keys(c).length !== 1 ||
      typeof c.currency !== "string" ||
      !/^[A-Z]{3}$/.test(c.currency)
    ) {
      return false;
    }
  }
  return !!query.trim() || hasFilter;
}
type Dependencies = {
  fetchProfile?: typeof fetchPublicJson;
  post?: typeof postPublicJson;
  requestId?: () => string;
  mcp?: typeof searchMcpCatalog;
};

/** Retain REST when both transports exist; no speculative fallback after failure. */
export function catalogEndpoint(
  merchant: VerifiedMerchant
): { transport: "rest" | "mcp"; url: string } | undefined {
  if (
    merchant.profile.version !== CATALOG_VERSION ||
    !merchant.profile.capabilities.some(
      (c) => c.name === CATALOG_CAPABILITY && c.version === CATALOG_VERSION
    )
  ) {
    return;
  }
  const rest = merchant.profile.restEndpoints.find(
    (e) => e.service === SHOPPING_SERVICE && e.version === CATALOG_VERSION
  );
  if (rest) {
    return { transport: "rest", url: rest.url };
  }
  const mcp = merchant.profile.services.find(
    (s) =>
      s.name === SHOPPING_SERVICE &&
      s.version === CATALOG_VERSION &&
      s.transport === "mcp" &&
      s.endpoint
  );
  if (mcp?.endpoint) {
    return { transport: "mcp", url: mcp.endpoint };
  }
}
const MAX_PRODUCTS = 20;
const MAX_VARIANTS = 20;

function invalid(): never {
  throw new Error("Invalid catalog response.");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid();
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && !value.length) ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    invalid();
  }
  return value;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    invalid();
  }
  return value;
}
function amount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalid();
  }
  return value;
}
function price(value: unknown): CatalogPrice {
  const p = record(value);
  const currency = text(p.currency, 3);
  if (!/^[A-Z]{3}$/.test(currency)) {
    invalid();
  }
  return { amount: amount(p.amount), currency };
}
function description(value: unknown): string | undefined {
  const d = record(value);
  // HTML is not interpreted or sent to the model. A plain or Markdown string is
  // rendered as literal text; HTML-only descriptions remain omitted.
  for (const field of ["plain", "markdown", "html"]) {
    if (d[field] !== undefined) {
      text(d[field], 8000, true);
    }
  }
  if (!["plain", "markdown", "html"].some((k) => typeof d[k] === "string")) {
    invalid();
  }
  const chosen = d.plain ?? d.markdown;
  return typeof chosen === "string" && chosen.length ? chosen.slice(0, 2000) : undefined;
}
function publicLink(value: unknown, allowQuery = true): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const url = safePublicUrl(text(value, 2048));
    // Product and variant queries can select the actual merchant offer. Images
    // retain the stricter credential-free media policy and never use a proxy.
    return !allowQuery && url.search ? undefined : url.href;
  } catch {
    return undefined;
  }
}
function images(value: unknown): CatalogImage[] {
  if (value === undefined) {
    return [];
  }
  const result: CatalogImage[] = [];
  for (const item of array(value, 32)) {
    const media = record(item);
    text(media.type, 32);
    if (media.type !== "image" || result.length === 8) {
      continue;
    }
    const url = publicLink(media.url, false);
    if (!url) {
      continue;
    }
    result.push({
      url,
      ...(media.alt_text === undefined ? {} : { alt: text(media.alt_text, 300) }),
    });
  }
  return result;
}
function variant(value: unknown): CatalogVariant {
  const v = record(value);
  const desc = description(v.description);
  const url = publicLink(v.url);
  const result: CatalogVariant = {
    id: text(v.id, 256),
    title: text(v.title, 300),
    images: images(v.media),
    price: price(v.price),
    ...(desc ? { description: desc } : {}),
    ...(url ? { url } : {}),
  };
  if (v.availability !== undefined) {
    const available = record(v.availability).available;
    if (typeof available !== "boolean") {
      invalid();
    }
    result.available = available;
  }
  if (v.options !== undefined) {
    result.options = array(v.options, 16).map((item) => {
      const option = record(item);
      return { name: text(option.name, 100), value: text(option.label, 100) };
    });
  }
  // Prices are per item. Refuse a different sale basis rather than
  // silently presenting a per-weight/time price as a per-item price.
  if (v.quantity_unit !== undefined) {
    const unit = record(v.quantity_unit);
    if (unit.unit !== "C62" || (unit.scale !== undefined && unit.scale !== 0)) {
      invalid();
    }
  }
  return result;
}
function product(value: unknown): CatalogProduct {
  const p = record(value);
  const variants = array(p.variants, MAX_VARIANTS).map(variant);
  if (!variants.length || new Set(variants.map((v) => v.id)).size !== variants.length) {
    invalid();
  }
  const range = record(p.price_range);
  const min = price(range.min),
    max = price(range.max);
  if (min.currency !== max.currency || min.amount > max.amount) {
    invalid();
  }
  if (
    variants.some(
      (v) =>
        v.price.currency !== min.currency ||
        v.price.amount < min.amount ||
        v.price.amount > max.amount
    )
  ) {
    invalid();
  }
  const desc = description(p.description);
  const url = publicLink(p.url);
  return {
    id: text(p.id, 256),
    title: text(p.title, 300),
    images: images(p.media),
    variants,
    priceRange: { min, max },
    ...(desc ? { description: desc } : {}),
    ...(url ? { url } : {}),
  };
}
function messages(value: unknown): CatalogMessage[] {
  if (value === undefined) {
    return [];
  }
  return array(value, 20).map((item) => {
    const m = record(item);
    if (m.type !== "error" && m.type !== "warning" && m.type !== "info") {
      invalid();
    }
    return {
      type: m.type,
      content: text(m.content, 1000),
      ...(m.code === undefined ? {} : { code: text(m.code, 100) }),
    };
  });
}

/** Project bounded business data, never arbitrary extra metadata or raw errors. */
export function parseCatalogResponse(
  body: unknown
): Pick<CatalogReport, "products" | "messages" | "pagination"> & { applicationError: boolean } {
  const root = record(body),
    ucp = record(root.ucp);
  if (
    ucp.version !== CATALOG_VERSION ||
    (ucp.status !== undefined && ucp.status !== "success" && ucp.status !== "error")
  ) {
    invalid();
  }
  if (ucp.capabilities !== undefined) {
    const capabilities = record(ucp.capabilities);
    // Merchants may also return our negotiated checkout capability. Reject
    // undeclared capabilities and incompatible versions before reading products.
    const supported: Record<string, { version: string }[]> =
      createPlatformProfile().ucp.capabilities;
    for (const [name, declarations] of Object.entries(capabilities)) {
      if (!Object.hasOwn(supported, name)) {
        invalid();
      }
      const active = array(declarations, 1);
      if (
        active.length !== 1 ||
        !supported[name].some((value) => value.version === record(active[0]).version)
      ) {
        invalid();
      }
    }
    const active = array(capabilities[CATALOG_CAPABILITY], 1);
    if (active.length !== 1 || record(active[0]).version !== CATALOG_VERSION) {
      invalid();
    }
  }
  const result = {
    products: [] as CatalogProduct[],
    messages: messages(root.messages),
    applicationError: ucp.status === "error",
  };
  result.applicationError ||= result.messages.some((message) => message.type === "error");
  if (result.applicationError) {
    if (!result.messages.some((message) => message.type === "error")) {
      invalid();
    }
    return result;
  }
  // Unknown actions can gate disclosure. Do not silently bypass required work.
  if (root.actions !== undefined && Object.keys(record(root.actions)).length > 0) {
    invalid();
  }
  result.products = array(root.products, MAX_PRODUCTS).map(product);
  if (new Set(result.products.map((p) => p.id)).size !== result.products.length) {
    invalid();
  }
  if (root.pagination === undefined) {
    return result;
  }
  const p = record(root.pagination);
  if (typeof p.has_next_page !== "boolean") {
    invalid();
  }
  const cursor = p.cursor === undefined ? undefined : text(p.cursor, 2048);
  if (p.has_next_page && !cursor) {
    invalid();
  }
  return {
    ...result,
    pagination: {
      hasNextPage: p.has_next_page,
      ...(cursor ? { cursor } : {}),
      ...(p.total_count === undefined ? {} : { totalCount: amount(p.total_count) }),
    },
  };
}

export async function catalogSearch(
  merchant: VerifiedMerchant,
  query: string,
  options: CatalogOptions,
  dependencies: Dependencies = {}
): Promise<CatalogReport> {
  const report: CatalogReport = {
    status: "unsupported",
    merchantDomain: merchant.domain,
    query,
    products: [],
    messages: [],
    ...(options.filters ? { filters: options.filters } : {}),
    ...(options.context ? { context: options.context } : {}),
    diagnostics: { profileUrl: merchant.profileUrl, version: merchant.profile.version },
  };
  if (
    !validCatalogSearch(query, options.filters, options.context) ||
    (options.cursor !== undefined && (!options.cursor.length || options.cursor.length > 2048))
  ) {
    return {
      ...report,
      status: "request_failed",
      diagnostics: { ...report.diagnostics, reason: "invalid_search_input" },
    };
  }
  const endpoint = catalogEndpoint(merchant);
  if (!endpoint) {
    report.diagnostics.reason = "catalog_capability_incompatible";
    return report;
  }
  let target: URL, profile: URL;
  try {
    const base = safePublicUrl(endpoint.url);
    if (base.search) {
      throw new Error();
    }
    target =
      endpoint.transport === "mcp"
        ? base
        : safePublicUrl(`${base.href.replace(/\/$/, "")}/catalog/search`);
    profile = safePublicUrl(merchant.profileUrl);
    if (
      profile.pathname !== "/.well-known/ucp" ||
      profile.hostname !== merchant.domain ||
      profile.search
    ) {
      throw new Error();
    }
  } catch {
    return {
      ...report,
      status: "request_failed",
      diagnostics: { ...report.diagnostics, reason: "unsafe_destination" },
    };
  }
  report.diagnostics.endpoint = target.href;
  report.diagnostics.transport = endpoint.transport;
  const identity = await verifyPlatformProfile(
    options.platformProfileUrl ?? process.env.UCP_PLATFORM_PROFILE_URL,
    [profile.origin, target.origin],
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
  const requestId = (dependencies.requestId ?? randomUUID)();
  if (endpoint.transport === "rest") {
    report.diagnostics.requestId = requestId;
  }
  const search = {
    ...(query.trim() ? { query: query.trim() } : {}),
    ...(options.filters ? { filters: options.filters } : {}),
    ...(options.context ? { context: options.context } : {}),
    pagination: { limit: 10, ...(options.cursor ? { cursor: options.cursor } : {}) },
  };
  try {
    if (endpoint.transport === "mcp") {
      const body = await (dependencies.mcp ?? searchMcpCatalog)(
        target.href,
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
    }
    const fetched = await (dependencies.post ?? postPublicJson)(
      target.href,
      search,
      { "Request-Id": requestId, "UCP-Agent": `profile="${identity.url}"` },
      options.signal
    );
    report.diagnostics.httpStatus = fetched.status;
    if (fetched.url !== target.href) {
      return {
        ...report,
        status: "request_failed",
        diagnostics: { ...report.diagnostics, reason: "unsafe_destination" },
      };
    }
    if (fetched.status < 200 || fetched.status >= 300) {
      // Only standardized, validated UCP messages are eligible for display.
      try {
        report.messages = parseCatalogResponse(fetched.body).messages;
      } catch {
        /* No raw server error disclosure. */
      }
      return {
        ...report,
        status: "request_failed",
        diagnostics: { ...report.diagnostics, reason: "http_error" },
      };
    }
    try {
      const parsed = parseCatalogResponse(fetched.body);
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
      status: "request_failed",
      diagnostics: {
        ...report.diagnostics,
        reason: error instanceof SafeFetchError ? error.code : "network_error",
      },
    };
  }
}
