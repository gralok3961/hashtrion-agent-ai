import { shoppingStore, shoppingOwner } from "../src/lib/server/shopping-state";
import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogReport } from "../src/lib/catalog-types";
import { POST } from "../src/app/api/catalog/page/route";
import { createSessionToken, SESSION_COOKIE_NAME } from "../src/lib/server/auth";
import { handleCatalogPage, readCatalogContinuation, withCatalogContinuation } from "../src/lib/server/catalog-pagination";
import { CATALOG_CAPABILITY, CATALOG_VERSION } from "../src/lib/server/platform-profile";
import { createUsageGuard } from "../src/lib/server/usage-guard";
import type { VerifiedMerchant } from "../src/lib/server/catalog";

const time = 1_800_000_000_000;
const env = {
  AGENT_AI_ACCESS_PASSWORD: "synthetic-page-password",
  AGENT_AI_SESSION_SECRET: "synthetic-page-signing-secret-not-real-credentials",
  MERCHANT_DISCOVERY_ENABLED: "true",
  UCP_PLATFORM_PROFILE_URL: "https://agent.example/.well-known/ucp",
};
function report(): CatalogReport {
  return {
    status: "completed", merchantDomain: "merchant.example", query: "",
    filters: { price: { min: 0 } }, products: [], messages: [],
    pagination: { hasNextPage: true, cursor: "actual-merchant-cursor", totalCount: 6 },
    diagnostics: { profileUrl: "https://merchant.example/.well-known/ucp" },
  };
}
function merchant(): VerifiedMerchant {
  return {
    domain: "merchant.example", status: "verified", profileUrl: "https://merchant.example/.well-known/ucp",
    profile: {
      version: CATALOG_VERSION,
      capabilities: [{ name: CATALOG_CAPABILITY, version: CATALOG_VERSION }],
      services: [{ name: "dev.ucp.shopping", version: CATALOG_VERSION, transport: "rest", endpoint: "https://api.merchant.example/ucp" }],
      restEndpoints: [{ service: "dev.ucp.shopping", version: CATALOG_VERSION, url: "https://api.merchant.example/ucp" }],
    },
  };
}
function token(): string {
  const result = withCatalogContinuation(report(), env.AGENT_AI_SESSION_SECRET, time).continuation;
  assert.ok(result);
  return result;
}
function request(continuation: unknown = token(), headers: Record<string, string> = {}, rawBody?: string) {
  return new Request("https://agent.example/api/catalog/page", {
    method: "POST",
    headers: {
      origin: "https://agent.example", host: "agent.example", "content-type": "application/json",
      cookie: `${SESSION_COOKIE_NAME}=${createSessionToken(env, time)}`, ...headers,
    },
    body: rawBody ?? JSON.stringify({ continuation }),
  });
}
const noNetwork = {
  verify: async () => assert.fail("No merchant lookup is authorized"),
  catalog: async () => assert.fail("No catalog request is authorized"),
};
const options = () => ({ env, now: () => time, acquire: createUsageGuard().acquire, ...noNetwork });

test("continuation binds genuine cursor and exact search filters without embedding endpoints", () => {
  const first = { ...report(), query: "research", filters: { categories: ["reports"], price: { min: 0, max: 500 } }, context: { currency: "USD" } };
  const continuation = withCatalogContinuation(first, env.AGENT_AI_SESSION_SECRET, time).continuation;
  assert.ok(continuation);
  const data = readCatalogContinuation(continuation, env.AGENT_AI_SESSION_SECRET, time);
  assert.ok(data);
  assert.deepEqual(data, {
    domain: first.merchantDomain, query: first.query, filters: first.filters, context: first.context,
    cursor: first.pagination?.cursor, expires: time + 30 * 60_000,
  });
  assert.equal("endpoint" in data, false);
  assert.equal(JSON.stringify(data).includes(env.AGENT_AI_SESSION_SECRET), false);
});

test("tampered, expired, rotated-secret and oversized continuations fail closed", () => {
  const original = token();
  const parts = original.split(".");
  const tampered = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  tampered.domain = "127.0.0.1";
  const replacement = `v1.${Buffer.from(JSON.stringify(tampered)).toString("base64url")}.${parts[2]}`;
  for (const bad of [replacement, "invalid", "x".repeat(8_193), original + ".extra"]) {
    assert.equal(readCatalogContinuation(bad, env.AGENT_AI_SESSION_SECRET, time), null);
  }
  assert.equal(readCatalogContinuation(original, env.AGENT_AI_SESSION_SECRET, time + 30 * 60_000), null);
  assert.equal(readCatalogContinuation(original, "different-synthetic-signing-secret-for-tests", time), null);
  assert.equal(readCatalogContinuation(original, env.AGENT_AI_SESSION_SECRET, time - 1), null);
});

test("continuations are issued only for successful actual next pages and secure signing configuration", () => {
  for (const value of [
    { ...report(), status: "request_failed" as const },
    { ...report(), pagination: { hasNextPage: false } },
    { ...report(), pagination: { hasNextPage: true } },
    { ...report(), merchantDomain: "127.0.0.1" },
  ]) assert.equal(withCatalogContinuation(value, env.AGENT_AI_SESSION_SECRET, time).continuation, undefined);
  assert.equal(withCatalogContinuation(report(), "short", time).continuation, undefined);
});

test("the actual page route returns 401 before parsing an unauthenticated body", async () => {
  const req = request(undefined, { cookie: "" }, "invalid JSON");
  const response = await POST(req);
  assert.equal(response.status, 401);
  assert.equal(req.bodyUsed, false);
});

test("page requests reject absent sessions, cross-site requests, disabled discovery and invalid bodies before I/O", async () => {
  for (const [req, status] of [
    [request(undefined, { cookie: "" }), 401],
    [request(undefined, { origin: "https://evil.example" }), 403],
    [request(undefined, { "content-type": "text/plain" }), 415],
    [request(undefined, {}, "not JSON"), 400],
    [request(undefined, {}, JSON.stringify({ continuation: token(), endpoint: "https://127.0.0.1" })), 400],
    [request("invalid"), 400],
    [request(undefined, {}, "x".repeat(12_289)), 413],
  ] as const) assert.equal((await handleCatalogPage(req, options())).status, status);
  assert.equal((await handleCatalogPage(request(), { ...options(), env: { ...env, MERCHANT_DISCOVERY_ENABLED: "false" } })).status, 403);
});

test("load-more revalidates the merchant and uses its current discovered endpoint and exact signed search", async () => {
  let verified = 0, searched = 0, released = 0;
  const response = await handleCatalogPage(request(), {
    env, now: () => time, acquire: () => () => { released++; },
    verify: async (sources) => {
      verified++;
      assert.deepEqual(sources, [{ url: "https://merchant.example/", title: "merchant.example", kind: "user_provided" }]);
      return [merchant()];
    },
    catalog: async (verifiedMerchant, query, opts) => {
      searched++;
      assert.deepEqual(verifiedMerchant, merchant());
      assert.equal(query, "");
      assert.equal(opts.cursor, "actual-merchant-cursor");
      assert.deepEqual(opts.filters, { price: { min: 0 } });
      assert.equal(opts.context, undefined);
      assert.equal(opts.platformProfileUrl, env.UCP_PLATFORM_PROFILE_URL);
      return { ...report(), pagination: { hasNextPage: true, cursor: "next-actual-cursor", totalCount: 6 } };
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.catalog.pagination.totalCount, 6);
  assert.equal(readCatalogContinuation(body.catalog.continuation, env.AGENT_AI_SESSION_SECRET, time)?.cursor, "next-actual-cursor");
  assert.deepEqual([verified, searched, released], [1, 1, 1]);
});

test("page requests share the existing usage ceiling and do not call merchants when exhausted", async () => {
  const guard = createUsageGuard({ concurrency: 1 });
  const release = guard.acquire();
  assert.ok(release);
  const response = await handleCatalogPage(request(), { ...options(), acquire: guard.acquire });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  release();
});

test("failed merchant re-verification prevents catalog calls and releases concurrency", async () => {
  let released = 0;
  const response = await handleCatalogPage(request(), {
    ...options(), acquire: () => () => { released++; },
    verify: async () => [{ domain: "merchant.example", profileUrl: "https://merchant.example/.well-known/ucp", status: "unverified", reason: "not_found" }],
  });
  assert.equal(response.status, 502);
  assert.equal(released, 1);
});

test("repeated cursors stop the load-more loop without changing merchant pagination metadata", async () => {
  const response = await handleCatalogPage(request(), {
    ...options(), verify: async () => [merchant()], catalog: async () => report(),
  });
  const body = await response.json();
  assert.deepEqual(body.catalog.pagination, report().pagination);
  assert.equal(body.catalog.continuation, undefined);
});

test("Global Catalog continuation binds the registered provider without environment selection or merchant discovery", async () => {
  const first: CatalogReport = { ...report(), provider: "shopify-global", merchantDomain: "catalog.shopify.com" };
  const continuation = withCatalogContinuation(first, env.AGENT_AI_SESSION_SECRET, time).continuation;
  assert.ok(continuation);
  assert.equal(readCatalogContinuation(continuation, env.AGENT_AI_SESSION_SECRET, time)?.provider, "shopify-global");
  let calls = 0;
  const response = await handleCatalogPage(request(continuation), {
    ...options(),
    providerCatalog: async (provider, query, opts) => {
      calls++;
      assert.equal(provider.endpoint, "https://catalog.shopify.com/api/ucp/mcp");
      assert.equal(query, first.query);
      assert.equal(opts.cursor, first.pagination?.cursor);
      return { ...first, pagination: { hasNextPage: true, cursor: "next-provider-page" } };
    },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(readCatalogContinuation(body.catalog.continuation, env.AGENT_AI_SESSION_SECRET, time)?.provider, "shopify-global");
  assert.equal(calls, 1);
  const disabled = await handleCatalogPage(request(continuation), {
    ...options(), providerLookup: () => undefined,
    providerCatalog: async () => assert.fail("Disabled provider cannot make requests"),
  });
  assert.equal(disabled.status, 403);
});

test("provider continuation cannot bind an unrelated merchant host", () => {
  assert.equal(withCatalogContinuation({ ...report(), provider: "shopify-global" }, env.AGENT_AI_SESSION_SECRET, time).continuation, undefined);
});


test("authenticated pagination preserves authoritative displayed order and rejects stale result pages", async () => {
  const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken(env, time)}`;
  const owner = shoppingOwner(request(undefined, { cookie }));
  const context = shoppingStore.acquire(owner);
  const product = (id: string) => ({ id, title: id, images: [], variants: [{ id: `variant_${id}`, title: id, images: [], price: { amount: 400, currency: "USD" } }] });
  context.state.catalog = withCatalogContinuation({ ...report(), products: [product("b"), product("a")] }, env.AGENT_AI_SESSION_SECRET, time);
  const continuation = context.state.catalog.continuation!;
  context.release();
  try {
    const req = request(undefined, { cookie }, JSON.stringify({ continuation, conversationId: context.id }));
    const response = await handleCatalogPage(req, { ...options(), verify: async () => [merchant()], catalog: async () => ({ ...report(), products: [product("a"), product("c")], pagination: { hasNextPage: false } }) });
    assert.equal(response.status, 200);
    assert.deepEqual(context.state.catalog.products.map(p => p.id), ["b", "a", "c"]);
    assert.equal(context.state.catalog.continuation, undefined);
    const stale = request(undefined, { cookie }, JSON.stringify({ continuation, conversationId: context.id }));
    assert.equal((await handleCatalogPage(stale, options())).status, 409);
  } finally { shoppingStore.reset(owner, context.id); }
});
