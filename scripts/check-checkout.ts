import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { createPlatformProfile } from "../src/lib/server/platform-profile";
import { randomUUID } from "node:crypto";
import { fetchPublicJson, requestUcpJson, safePublicUrl } from "../src/lib/server/safe-http";
import { parseUcpProfile } from "../src/lib/server/ucp-profile";
import { parseCatalogResponse } from "../src/lib/server/catalog";
import { connectCheckout, checkoutRequest, CheckoutError } from "../src/lib/server/checkout";

// --mutate permits unpaid checkout lifecycle tests only. This script has no complete operation.
async function main() {
  const [domain, rawPlatform, query = "", flag] = process.argv.slice(2);
  if (flag !== undefined && flag !== "--mutate") {
    throw new Error("unsupported_flag");
  }
  if (!domain || !rawPlatform) {
    throw new Error("usage");
  }
  const platform = safePublicUrl(rawPlatform);
  if (platform.search || platform.pathname !== "/.well-known/ucp") {
    throw new Error("invalid_profile");
  }
  const signal = AbortSignal.timeout(45_000);
  const own = await fetchPublicJson(platform.href, signal);
  const expected = createPlatformProfile();
  const ownUcp = (own.body as { ucp?: Record<string, unknown> })?.ucp;
  const profileDifferences = (
    ["version", "services", "capabilities", "payment_handlers"] as const
  ).filter((key) => !isDeepStrictEqual(ownUcp?.[key], expected.ucp[key]));
  console.log(
    JSON.stringify({
      platformProfileUrl: platform.href,
      profileMatchesLocal: isDeepStrictEqual(own.body, expected),
      profileDifferences,
      ucpAgent: `profile="${platform.href}"`,
    })
  );
  const merchant = safePublicUrl(`https://${domain}/.well-known/ucp`);
  if (merchant.hostname !== domain) {
    throw new Error("invalid_domain");
  }
  const profile = parseUcpProfile((await fetchPublicJson(merchant.href, signal)).body);
  const endpoint = profile.restEndpoints.find(
    (e) => e.service === "dev.ucp.shopping" && e.version === "2026-08-25"
  )?.url;
  if (!endpoint) {
    throw new Error("rest_unsupported");
  }
  console.log(
    JSON.stringify({
      discoveredRestEndpoint: endpoint,
      merchantVersion: profile.version,
      checkoutAdvertised: profile.capabilities.some(
        (c) => c.name === "dev.ucp.shopping.checkout" && c.version === "2026-08-25"
      ),
    })
  );
  const response = await requestUcpJson(
    `${endpoint.replace(/\/$/, "")}/catalog/search`,
    "POST",
    { ...(query ? { query } : { filters: { price: { min: 0 } } }), pagination: { limit: 5 } },
    { "Request-Id": randomUUID(), "UCP-Agent": `profile="${platform.href}"` },
    signal
  );
  const catalog = parseCatalogResponse(response.body);
  if (response.status !== 200 || catalog.applicationError) {
    throw new CheckoutError("catalog_request_failed");
  }
  console.log(
    JSON.stringify({
      catalogHttp: response.status,
      applicationError: catalog.applicationError,
      products: catalog.products.map((p) => ({
        id: p.id,
        title: p.title,
        variants: p.variants.map((v) => ({ id: v.id, price: v.price })),
      })),
    })
  );
  const connection = await connectCheckout(domain, signal, platform.href);
  console.log(
    JSON.stringify({
      checkoutConnection: "verified",
      handlerAvailable: !!connection.handler,
      handlerId: connection.handler?.id,
      handlerAssets: connection.handler?.assets,
    })
  );
  if (flag !== "--mutate") {
    return;
  }
  if (catalog.products.length !== 1 || catalog.products[0].variants.length !== 1) {
    throw new CheckoutError("ambiguous_catalog_selection");
  }
  const variant = catalog.products[0].variants[0];
  if (variant.available === false) {
    throw new CheckoutError("unavailable_variant");
  }
  let checkout = await checkoutRequest(
    connection,
    "create",
    undefined,
    { line_items: [{ item: { id: variant.id }, quantity: 1 }] },
    randomUUID(),
    signal
  );
  console.log(
    JSON.stringify({
      create: checkout.status,
      id: checkout.id,
      items: checkout.items,
      total: checkout.total,
      currency: checkout.currency,
      errors: checkout.errors,
    })
  );
  try {
    const checkSelection = (quantity: number) => {
      assert.equal(checkout.items.length, 1);
      assert.equal(checkout.items[0].itemId, variant.id);
      assert.equal(checkout.items[0].quantity, quantity);
      assert.equal(checkout.currency, variant.price.currency);
      assert.ok(["incomplete", "ready_for_complete"].includes(checkout.status));
      assert.ok(checkout.errors.every((code) => code === "field_required" || code === "missing"));
    };
    checkSelection(1);
    checkout = await checkoutRequest(
      connection,
      "get",
      checkout.id,
      undefined,
      randomUUID(),
      signal
    );
    checkSelection(1);
    console.log(
      JSON.stringify({ initialGet: checkout.status, id: checkout.id, total: checkout.total })
    );
    checkout = await checkoutRequest(
      connection,
      "update",
      checkout.id,
      {
        line_items: checkout.items.map((i) => ({ id: i.id, item: { id: i.itemId }, quantity: 2 })),
      },
      randomUUID(),
      signal
    );
    checkSelection(2);
    console.log(
      JSON.stringify({
        update: checkout.status,
        id: checkout.id,
        items: checkout.items,
        total: checkout.total,
        currency: checkout.currency,
      })
    );
    const updated = checkout;
    checkout = await checkoutRequest(
      connection,
      "get",
      checkout.id,
      undefined,
      randomUUID(),
      signal
    );
    checkSelection(2);
    assert.deepEqual(checkout.items, updated.items);
    assert.equal(checkout.total, updated.total);
    assert.equal(checkout.status, updated.status);
    console.log(
      JSON.stringify({
        finalGet: checkout.status,
        id: checkout.id,
        total: checkout.total,
        currency: checkout.currency,
      })
    );
  } finally {
    const canceled = await checkoutRequest(
      connection,
      "cancel",
      checkout.id,
      {},
      randomUUID(),
      AbortSignal.timeout(10_000)
    );
    console.log(JSON.stringify({ cancel: canceled.status, id: canceled.id }));
    assert.equal(canceled.status, "canceled");
  }
}
main().catch((e) => {
  console.log(
    JSON.stringify({
      blocked: e instanceof CheckoutError ? e.code : "public_integration_check_failed",
      paymentAttempted: false,
    })
  );
  process.exitCode = 1;
});
