import assert from "node:assert/strict";
import test from "node:test";
import { catalogSearch, parseCatalogResponse, type VerifiedMerchant } from "../src/lib/server/catalog";
import { CATALOG_CAPABILITY, CATALOG_VERSION, createPlatformProfile } from "../src/lib/server/platform-profile";
import { SafeFetchError } from "../src/lib/server/safe-http";
import { isCatalogReport } from "../src/lib/catalog-types";

const SIGNAL = new AbortController().signal;
const PROFILE = "https://agent.example/.well-known/ucp";
const REQUEST_ID = "53413436-3d50-4c2b-b09f-8df382aab655";
function merchant(): VerifiedMerchant {
  return { domain: "merchant.example", profileUrl: "https://merchant.example/.well-known/ucp", status: "verified", profile: {
    version: CATALOG_VERSION,
    services: [{ name: "dev.ucp.shopping", version: CATALOG_VERSION, transport: "rest", endpoint: "https://api.merchant.example/ucp/v1" }],
    capabilities: [{ name: CATALOG_CAPABILITY, version: CATALOG_VERSION }],
    restEndpoints: [{ service: "dev.ucp.shopping", version: CATALOG_VERSION, url: "https://api.merchant.example/ucp/v1" }],
  } };
}
function response() {
  return {
    ucp: { version: CATALOG_VERSION, capabilities: { [CATALOG_CAPABILITY]: [{ version: CATALOG_VERSION }] } },
    products: [{
      id: "report-1", title: "Quarterly Research Report", description: { plain: "Actual merchant description" },
      url: "https://merchant.example/products/report-1",
      price_range: { min: { amount: 400, currency: "USD" }, max: { amount: 400, currency: "USD" } },
      media: [{ type: "image", url: "https://images.merchant.example/report.png", alt_text: "Report cover" }],
      variants: [{ id: "report-pdf", title: "PDF", description: { plain: "Downloadable PDF report" }, price: { amount: 400, currency: "USD" }, availability: { available: true }, options: [{ name: "Format", label: "PDF" }] }],
    }],
    pagination: { has_next_page: true, cursor: "opaque-cursor", total_count: 2 },
    messages: [{ type: "info", code: "catalog_notice", content: "Prices are current." }],
  };
}
const identity = async (url: string) => ({ url, body: createPlatformProfile() });
const options = { signal: SIGNAL, platformProfileUrl: PROFILE };

test("catalog accepts the advertised checkout capability while rejecting incompatible or unknown declarations", () => {
  const body = response();
  const withCapability = (name: string, declarations: unknown) => ({
    ...body, ucp: { ...body.ucp, capabilities: { ...body.ucp.capabilities, [name]: declarations } },
  });
  const parsed = parseCatalogResponse(withCapability("dev.ucp.shopping.checkout", [{ version: CATALOG_VERSION }]));
  assert.equal(parsed.products[0].variants[0].price.amount, 400);
  assert.equal(parsed.products[0].variants[0].price.currency, "USD");
  for (const declarations of [[], [{ version: "2026-04-08" }], [{}], [{ version: CATALOG_VERSION }, { version: CATALOG_VERSION }]]) {
    assert.throws(() => parseCatalogResponse(withCapability("dev.ucp.shopping.checkout", declarations)));
  }
  assert.throws(() => parseCatalogResponse(withCapability("com.example.unnegotiated", [{ version: CATALOG_VERSION }])));
  assert.throws(() => parseCatalogResponse({ ...body, ucp: { ...body.ucp, capabilities: { "dev.ucp.shopping.checkout": [{ version: CATALOG_VERSION }] } } }));
});

test("verified catalog uses discovered base path, genuine platform identity and official headers/body", async () => {
  let calls = 0;
  const result = await catalogSearch(merchant(), "research reports", { ...options, cursor: "previous-page" }, {
    fetchProfile: identity, requestId: () => REQUEST_ID,
    post: async (url, body, headers, signal) => {
      calls++;
      assert.equal(url, "https://api.merchant.example/ucp/v1/catalog/search");
      assert.deepEqual(body, { query: "research reports", pagination: { limit: 10, cursor: "previous-page" } });
      assert.deepEqual(headers, { "Request-Id": REQUEST_ID, "UCP-Agent": `profile="${PROFILE}"` });
      assert.equal(signal, SIGNAL);
      return { url, body: response(), status: 200 };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "completed");
  assert.equal(result.products[0].variants[0].price.amount, 400);
  assert.deepEqual(result.products[0].variants[0].options, [{ name: "Format", value: "PDF" }]);
  assert.equal(result.products[0].images[0].alt, "Report cover");
  assert.equal(result.products[0].description, "Actual merchant description");
  assert.deepEqual(result.pagination, { hasNextPage: true, cursor: "opaque-cursor", totalCount: 2 });
  assert.equal(isCatalogReport(result), true);
});

test("missing or incompatible catalog capability never makes a platform fetch or POST", async () => {
  for (const altered of [
    { ...merchant().profile, capabilities: [] },
    { ...merchant().profile, capabilities: [{ name: CATALOG_CAPABILITY, version: "2026-04-08" }] },
    { ...merchant().profile, restEndpoints: [{ service: "com.example.other", version: CATALOG_VERSION, url: "https://api.merchant.example/other" }] },
    { ...merchant().profile, version: "2026-04-08" },
  ]) {
    const result = await catalogSearch({ ...merchant(), profile: altered }, "reports", options, {
      fetchProfile: async () => assert.fail("Must not resolve identity"), post: async () => assert.fail("Must not call catalog"),
    });
    assert.equal(result.status, "unsupported");
  }
});

test("missing, unreachable or merchant platform identity blocks POST", async () => {
  for (const [platformProfileUrl, fetchProfile, reason] of [
    ["", identity, "platform_profile_not_configured"],
    [PROFILE, async () => { throw new SafeFetchError("not_found"); }, "platform_profile_unreachable"],
    ["https://merchant.example/.well-known/ucp", identity, "platform_profile_is_merchant"],
    ["https://api.merchant.example/.well-known/ucp", identity, "platform_profile_is_merchant"],
  ] as const) {
    const result = await catalogSearch(merchant(), "reports", { ...options, platformProfileUrl }, { fetchProfile, post: async () => assert.fail("No POST without platform identity") });
    assert.equal(result.status, "platform_unavailable");
    assert.equal(result.diagnostics.reason, reason);
  }
});

test("application error with HTTP 200 remains merchant_error with no products", async () => {
  const result = await catalogSearch(merchant(), "reports", options, { fetchProfile: identity, post: async url => ({ url, status: 200, body: { ucp: { version: CATALOG_VERSION, status: "error" }, messages: [{ type: "error", code: "no_catalog", content: "Catalog is temporarily unavailable." }] } }) });
  assert.equal(result.status, "merchant_error");
  assert.deepEqual(result.products, []);
  assert.equal(result.messages[0].code, "no_catalog");
});

test("non-2xx errors cannot become successful products and raw errors are withheld", async () => {
  for (const body of [response(), { error: "Internal database password and stack must never be shown" }]) {
    const result = await catalogSearch(merchant(), "reports", options, { fetchProfile: identity, post: async url => ({ url, status: 500, body }) });
    assert.equal(result.status, "request_failed");
    assert.deepEqual(result.products, []);
    assert.ok(!JSON.stringify(result).includes("password"));
  }
});

test("malformed product amounts, prices, pagination and incompatible responses fail closed", async () => {
  const mutations: ((value: ReturnType<typeof response>) => void)[] = [
    value => { value.products[0].variants[0].price.amount = 4.01; },
    value => { value.products[0].variants[0].price.amount = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.products[0].variants[0].price.amount = -400; },
    value => { value.products[0].price_range.max.amount = 399; },
    value => { value.products[0].variants[0].price.currency = "EUR"; },
    value => { value.ucp.version = "2099-01-01"; },
    value => { value.pagination.cursor = ""; },
  ];
  for (const mutate of mutations) {
    const body = response(); mutate(body);
    const result = await catalogSearch(merchant(), "reports", options, { fetchProfile: identity, post: async url => ({ url, status: 200, body }) });
    assert.equal(result.status, "invalid_response");
    assert.deepEqual(result.products, []);
  }
});

test("unsafe and credential-bearing product or media links are not surfaced", () => {
  const body = response();
  body.products[0].url = "https://127.0.0.1/admin";
  body.products[0].media = [
    { type: "image", url: "http://images.merchant.example/report.png", alt_text: "bad" },
    { type: "image", url: "https://images.merchant.example/report.png?token=secret", alt_text: "bad" },
    { type: "image", url: "https://169.254.169.254/metadata", alt_text: "bad" },
  ];
  const result = parseCatalogResponse(body);
  assert.equal(result.products[0].url, undefined);
  assert.deepEqual(result.products[0].images, []);
  assert.ok(!JSON.stringify(result).includes("secret"));
});

test("actual product and variant URL queries survive normalization while image queries stay blocked", () => {
  const body = response();
  const productUrl = "https://seller.example/products/report?country=US&currency=USD";
  const variantUrl = "https://seller.example/products/report?variant=123&country=US";
  body.products[0].url = productUrl;
  Object.assign(body.products[0].variants[0], { url: variantUrl });
  body.products[0].media[0].url = "https://images.merchant.example/report.png?token=synthetic";
  const parsed = parseCatalogResponse(body);
  assert.equal(parsed.products[0].url, productUrl);
  assert.equal(parsed.products[0].variants[0].url, variantUrl);
  assert.deepEqual(parsed.products[0].images, []);
  for (const unsafe of ["http://seller.example/products/report?variant=123", "https://127.0.0.1/report?variant=123", "https://user:synthetic@seller.example/report?variant=123"]) {
    body.products[0].url = unsafe;
    Object.assign(body.products[0].variants[0], { url: unsafe });
    const blocked = parseCatalogResponse(body);
    assert.equal(blocked.products[0].url, undefined);
    assert.equal(blocked.products[0].variants[0].url, undefined);
  }
});

test("empty real catalog is a valid empty result; no manufactured products or price", () => {
  const body = response(); body.products = []; body.pagination = { has_next_page: false, cursor: "end", total_count: 0 };
  assert.deepEqual(parseCatalogResponse(body).products, []);
});

test("transport failures, unsafe endpoint and redirects keep empty product results", async () => {
  const unsafe = merchant(); unsafe.profile.restEndpoints[0].url = "https://127.0.0.1";
  const result = await catalogSearch(unsafe, "reports", options, { post: async () => assert.fail("Unsafe destination must not be sent") });
  assert.equal(result.diagnostics.reason, "unsafe_destination");
  for (const post of [
    async () => { throw new SafeFetchError("timeout"); },
    async () => ({ url: "https://elsewhere.example/catalog/search", status: 200, body: response() }),
  ]) {
    const failed = await catalogSearch(merchant(), "reports", options, { fetchProfile: identity, post });
    assert.equal(failed.status, "request_failed");
    assert.deepEqual(failed.products, []);
  }
});

test("unnegotiated extension actions and non-item sale basis are not silently ignored", () => {
  assert.throws(() => parseCatalogResponse({ ...response(), actions: { "com.example.consent": [{ id: "consent-1" }] } }));
  const body = response();
  Object.assign(body.products[0].variants[0], { quantity_unit: { unit: "LBR", scale: 2 } });
  assert.throws(() => parseCatalogResponse(body));
});

test("HTTP 200 with an error message cannot present products as a successful search", async () => {
  for (const status of [undefined, "success"]) {
    const body = { ...response(), ucp: { ...response().ucp, ...(status ? { status } : {}) }, messages: [{ type: "error", code: "catalog_restricted", content: "This catalog is unavailable." }] };
    const result = await catalogSearch(merchant(), "reports", options, { fetchProfile: identity, post: async url => ({ url, status: 200, body }) });
    assert.equal(result.status, "merchant_error");
    assert.deepEqual(result.products, []);
    assert.equal(result.messages[0].code, "catalog_restricted");
  }
});

test("official filter-only browsing omits query and preserves merchant warning and pagination", async () => {
  const result = await catalogSearch(merchant(), "", { ...options, filters: { price: { min: 0 } }, cursor: "browse-page" }, {
    fetchProfile: identity,
    post: async (url, body) => {
      assert.deepEqual(body, { filters: { price: { min: 0 } }, pagination: { limit: 10, cursor: "browse-page" } });
      const data = response();
      data.messages = [{ type: "info", code: "price_filter_ignored", content: "The price filter was ignored because currency was not specified." }];
      return { url, status: 200, body: data };
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.query, "");
  assert.deepEqual(result.filters, { price: { min: 0 } });
  assert.equal(result.messages[0].code, "price_filter_ignored");
  assert.equal(result.pagination?.cursor, "opaque-cursor");
  assert.equal(isCatalogReport(result), true);
});

test("empty searches and invalid filters fail before profile or catalog network calls", async () => {
  for (const extra of [
    {}, { filters: {} }, { filters: { price: {} } }, { filters: { price: { min: -1 } } },
    { filters: { price: { min: 500, max: 400 } } }, { filters: { categories: [] } },
    { filters: { price: { min: 0 } }, context: { currency: "usd" } },
  ]) {
    const result = await catalogSearch(merchant(), "", { ...options, ...extra }, {
      fetchProfile: async () => assert.fail("Invalid search must not fetch a profile"),
      post: async () => assert.fail("Invalid search must not POST"),
    });
    assert.equal(result.status, "request_failed");
    assert.equal(result.diagnostics.reason, "invalid_search_input");
  }
});

test("multiple actual products and Azure Blob images are retained without generated substitutes", () => {
  const body = response();
  body.products[0].media[0].url = "https://merchantstorage.blob.core.windows.net/products/cover.png";
  body.products.push({ ...body.products[0], id: "report-2", title: "Second real report" });
  const result = parseCatalogResponse(body);
  assert.equal(result.products.length, 2);
  assert.equal(result.products[0].images[0].url, "https://merchantstorage.blob.core.windows.net/products/cover.png");
  assert.equal(result.products[1].title, "Second real report");
});
