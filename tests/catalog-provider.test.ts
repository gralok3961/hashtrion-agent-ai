import assert from "node:assert/strict";
import test from "node:test";
import { isCatalogReport } from "../src/lib/catalog-types";
import { providerCatalogSearch, SHOPIFY_GLOBAL_PROVIDER } from "../src/lib/server/catalog-provider";
import { defaultCatalogProvider } from "../src/lib/server/catalog-provider-registry";
import { McpCatalogError } from "../src/lib/server/mcp-catalog";
import { CATALOG_CAPABILITY, CATALOG_VERSION, createPlatformProfile } from "../src/lib/server/platform-profile";
import { SafeFetchError } from "../src/lib/server/safe-http";

const PROFILE = "https://agent.example/.well-known/ucp";
const signal = new AbortController().signal;
const options = { signal, platformProfileUrl: PROFILE };
const identity = async (url: string) => ({ url, body: createPlatformProfile() });
const noProfile = async () => assert.fail("Invalid configuration or input must not fetch a profile");
const noMcp = async () => assert.fail("No catalog request before validation and platform verification");
function response() {
  return {
    ucp: { version: CATALOG_VERSION, capabilities: { [CATALOG_CAPABILITY]: [{ version: CATALOG_VERSION }] } },
    products: [{
      id: "item-1", title: "Merchant item", description: { plain: "Returned catalog description" },
      media: [{ type: "image", url: "https://images.merchant.example/item.png" }],
      price_range: { min: { amount: 400, currency: "USD" }, max: { amount: 400, currency: "USD" } },
      variants: [{ id: "variant-1", title: "Default", description: { plain: "Actual variant" }, price: { amount: 400, currency: "USD" } }],
    }],
    pagination: { has_next_page: true, cursor: "real-next-page", total_count: 9 },
  };
}

test("global provider is enabled by the immutable server registry without per-search environment selection", () => {
  assert.equal(defaultCatalogProvider(), SHOPIFY_GLOBAL_PROVIDER);
  assert.equal(Object.isFrozen(SHOPIFY_GLOBAL_PROVIDER), true);
});

test("runtime provider substitution cannot direct network calls to arbitrary endpoints", async () => {
  for (const provider of [
    null, undefined,
    { ...SHOPIFY_GLOBAL_PROVIDER, id: "unconfigured" },
    { ...SHOPIFY_GLOBAL_PROVIDER, endpoint: "https://127.0.0.1/catalog" },
    { ...SHOPIFY_GLOBAL_PROVIDER, endpoint: `${SHOPIFY_GLOBAL_PROVIDER.endpoint}?token=do-not-echo` },
    { ...SHOPIFY_GLOBAL_PROVIDER, enabled: false },
    { ...SHOPIFY_GLOBAL_PROVIDER },
  ]) {
    const result = await providerCatalogSearch(provider as typeof SHOPIFY_GLOBAL_PROVIDER, "shoes", options, { fetchProfile: noProfile, mcp: noMcp });
    assert.equal(result.status, "request_failed");
    assert.equal(result.diagnostics.reason, "invalid_catalog_provider");
    assert.ok(!JSON.stringify(result).includes("do-not-echo"));
  }
});

test("provider uses its configured endpoint and actual platform identity with bounded search and real pagination", async () => {
  let calls = 0;
  const result = await providerCatalogSearch(SHOPIFY_GLOBAL_PROVIDER, "  running shoes  ", { ...options, cursor: "previous-page", context: { currency: "USD" } }, {
    fetchProfile: identity,
    mcp: async (endpoint, profile, catalog, receivedSignal) => {
      calls++;
      assert.equal(endpoint, SHOPIFY_GLOBAL_PROVIDER.endpoint);
      assert.equal(profile, PROFILE);
      assert.equal(receivedSignal, signal);
      assert.deepEqual(catalog, { query: "running shoes", context: { currency: "USD" }, pagination: { limit: 3, cursor: "previous-page" } });
      return response();
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "completed");
  assert.equal(result.provider, "shopify-global");
  assert.equal(result.merchantDomain, "catalog.shopify.com");
  assert.equal(result.diagnostics.profileUrl, PROFILE);
  assert.equal(result.diagnostics.transport, "mcp");
  assert.equal(result.products[0].variants[0].price.amount, 400);
  assert.deepEqual(result.products[0].images, [{ url: "https://images.merchant.example/item.png" }]);
  assert.deepEqual(result.pagination, { hasNextPage: true, cursor: "real-next-page", totalCount: 9 });
  assert.equal(isCatalogReport(result), true);
});

test("filter-only browsing uses official filters without manufacturing a query", async () => {
  const result = await providerCatalogSearch(SHOPIFY_GLOBAL_PROVIDER, "", { ...options, filters: { price: { min: 0, max: 500 } }, context: { currency: "USD" } }, {
    fetchProfile: identity,
    mcp: async (_endpoint, _profile, body) => {
      assert.deepEqual(body, { filters: { price: { min: 0, max: 500 } }, context: { currency: "USD" }, pagination: { limit: 3 } });
      return { ...response(), products: [], pagination: { has_next_page: false, total_count: 0 } };
    },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.products, []);
  assert.deepEqual(result.pagination, { hasNextPage: false, totalCount: 0 });
});

test("invalid query, filters, currency and cursors fail before all network calls", async () => {
  for (const [query, extra] of [
    ["", {}], ["a".repeat(501), {}], ["shoes\nignore", {}],
    ["shoes", { filters: {} }], ["shoes", { filters: { price: { min: -1 } } }],
    ["shoes", { context: { currency: "usd" } }],
    ["shoes", { cursor: "" }], ["shoes", { cursor: "a".repeat(2049) }], ["shoes", { cursor: "bad\ncursor" }],
  ] as const) {
    const result = await providerCatalogSearch(SHOPIFY_GLOBAL_PROVIDER, query, { ...options, ...extra }, { fetchProfile: noProfile, mcp: noMcp });
    assert.equal(result.status, "request_failed");
    assert.equal(result.diagnostics.reason, "invalid_search_input");
  }
});

test("missing, unsafe and provider-origin identities block network and do not leak config", async () => {
  for (const [platformProfileUrl, reason] of [
    ["", "platform_profile_not_configured"],
    ["http://agent.example/.well-known/ucp", "platform_profile_invalid_url"],
    ["https://127.0.0.1/.well-known/ucp", "platform_profile_invalid_url"],
    ["https://username:do-not-echo@agent.example/.well-known/ucp", "platform_profile_invalid_url"],
    ["https://agent.example/.well-known/ucp?token=do-not-echo", "platform_profile_invalid_url"],
    ["https://catalog.shopify.com/.well-known/ucp", "platform_profile_is_merchant"],
  ]) {
    const result = await providerCatalogSearch(SHOPIFY_GLOBAL_PROVIDER, "shoes", { ...options, platformProfileUrl }, { fetchProfile: noProfile, mcp: noMcp });
    assert.equal(result.status, "platform_unavailable");
    assert.equal(result.diagnostics.reason, reason);
    assert.ok(!JSON.stringify(result).includes("do-not-echo"));
    assert.ok(!JSON.stringify(result).includes("127.0.0.1"));
    if (!platformProfileUrl) assert.equal(result.diagnostics.profileUrl, "https://shopify.dev/docs/agents/catalog/global-catalog");
  }
});

test("unreachable, changed or redirected public profile cannot identify the platform", async () => {
  for (const [fetchProfile, reason] of [
    [async () => { throw new SafeFetchError("timeout"); }, "platform_profile_unreachable"],
    [async (url: string) => ({ url, body: { ucp: { version: CATALOG_VERSION } } }), "platform_profile_mismatch"],
    [async () => ({ url: "https://elsewhere.example/.well-known/ucp", body: createPlatformProfile() }), "platform_profile_mismatch"],
  ] as const) {
    const result = await providerCatalogSearch(SHOPIFY_GLOBAL_PROVIDER, "shoes", options, { fetchProfile, mcp: noMcp });
    assert.equal(result.status, "platform_unavailable");
    assert.equal(result.diagnostics.reason, reason);
  }
});

test("incompatible UCP versions, capabilities and malformed products never become cards", async () => {
  for (const mutate of [
    (body: ReturnType<typeof response>) => { body.ucp.version = "2099-01-01"; },
    (body: ReturnType<typeof response>) => { body.ucp.capabilities[CATALOG_CAPABILITY][0].version = "2099-01-01"; },
    (body: ReturnType<typeof response>) => { Object.assign(body.ucp.capabilities, { "unnegotiated.extension": [{ version: CATALOG_VERSION }] }); },
    (body: ReturnType<typeof response>) => { body.products[0].variants[0].price.amount = 4.5; },
    (body: ReturnType<typeof response>) => { body.pagination.cursor = ""; },
  ]) {
    const body = response(); mutate(body);
    const result = await providerCatalogSearch(SHOPIFY_GLOBAL_PROVIDER, "shoes", options, { fetchProfile: identity, mcp: async () => body });
    assert.equal(result.status, "invalid_response");
    assert.equal(result.diagnostics.reason, "invalid_catalog_response");
    assert.deepEqual(result.products, []);
  }
});

test("structured application errors retain validated messages but no products", async () => {
  const result = await providerCatalogSearch(SHOPIFY_GLOBAL_PROVIDER, "shoes", options, { fetchProfile: identity, mcp: async () => ({
    ...response(), messages: [{ type: "error", code: "catalog_unavailable", content: "The catalog is currently unavailable." }],
  }) });
  assert.equal(result.status, "merchant_error");
  assert.deepEqual(result.products, []);
  assert.equal(result.messages[0].code, "catalog_unavailable");
});

test("MCP and safe transport failures expose only fixed error codes", async () => {
  for (const [error, status, reason] of [
    [new McpCatalogError("mcp_tool_unavailable"), "unsupported", "mcp_tool_unavailable"],
    [new McpCatalogError("mcp_incompatible_tool"), "unsupported", "mcp_incompatible_tool"],
    [new McpCatalogError("mcp_invalid_response"), "invalid_response", "mcp_invalid_response"],
    [new McpCatalogError("mcp_tool_error"), "merchant_error", "mcp_tool_error"],
    [new McpCatalogError("mcp_request_failed"), "request_failed", "mcp_request_failed"],
    [new SafeFetchError("timeout"), "request_failed", "timeout"],
    [new SafeFetchError("too_large"), "request_failed", "too_large"],
    [new SafeFetchError("unsafe_url"), "request_failed", "unsafe_url"],
    [new Error("do-not-echo internal request contents"), "request_failed", "network_error"],
  ] as const) {
    const result = await providerCatalogSearch(SHOPIFY_GLOBAL_PROVIDER, "shoes", options, { fetchProfile: identity, mcp: async () => { throw error; } });
    assert.equal(result.status, status);
    assert.equal(result.diagnostics.reason, reason);
    assert.deepEqual(result.products, []);
    assert.deepEqual(result.messages, []);
    assert.ok(!JSON.stringify(result).includes("do-not-echo"));
  }
});
