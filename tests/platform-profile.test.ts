import assert from "node:assert/strict";
import test from "node:test";
import { createPlatformProfile, verifyPlatformProfile, CATALOG_CAPABILITY, CATALOG_VERSION } from "../src/lib/server/platform-profile";
import { GET } from "../src/app/.well-known/ucp/route";
import { parsePaymentHandler } from "../src/lib/server/payment-handler-discovery";

const URL = "https://agent.example/.well-known/ucp";
const SIGNAL = new AbortController().signal;

test("public platform advertises catalog, checkout and the supported Hashtrion instrument contract", async () => {
  const response = GET();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  const profile = await response.json();
  assert.deepEqual(profile, createPlatformProfile());
  assert.equal(profile.ucp.version, CATALOG_VERSION);
  assert.deepEqual(Object.keys(profile.ucp.capabilities), ["dev.ucp.shopping.checkout", CATALOG_CAPABILITY]);
  assert.deepEqual(profile.ucp.payment_handlers["com.hashtrion.pay"], [{ id: "hashtrion_pay", available_instruments: [{ type: "digital_asset", constraints: { properties: { network: { const: "xrpl" } } } }], version: "2026-10-16", spec: "https://www.hashtrion.com/ucp/payment-handlers/com.hashtrion.pay", schema: "https://pay.hashtrion.com/ucp/payment-handlers/com.hashtrion.pay/schema.json" }]);
  assert.equal("endpoint" in profile.ucp.services["dev.ucp.shopping"][0], false);
  const expectedKey = {
    kid: "shopping-agent", kty: "EC", crv: "P-256",
    x: "eNxUo9BEtpXQp3hUDmPKSmrlKmDkFUKmN_XA-xk72Q0",
    y: "N8yhxtYrTqcqhLxayizz0EHCZXnEgXOTPWSeARd6jCA",
    use: "sig", alg: "ES256",
  };
  assert.deepEqual(profile.signing_keys, [expectedKey]);
  assert.deepEqual(profile.keys, profile.signing_keys);
  assert.deepEqual(Object.keys(profile).sort(), ["keys", "signing_keys", "ucp"]);
  assert.equal("d" in profile.signing_keys[0], false);
});

test("public profile must be fetched at configured URL and match actual implemented platform contract", async () => {
  let count = 0;
  const result = await verifyPlatformProfile(URL, ["https://merchant.example"], SIGNAL, async (url, signal) => {
    count++; assert.equal(url, URL); assert.equal(signal, SIGNAL);
    return { url, body: createPlatformProfile() };
  });
  assert.equal(count, 1);
  assert.deepEqual(result, { ok: true, url: URL });
  const mismatched = createPlatformProfile();
  Object.assign(mismatched.ucp.services["dev.ucp.shopping"][0], { endpoint: "https://merchant.example/ucp" });
  assert.deepEqual(await verifyPlatformProfile(URL, [], SIGNAL, async url => ({ url, body: mismatched })), { ok: false, reason: "platform_profile_mismatch" });
});

test("unsafe URLs, merchant identity and missing configuration do not perform HTTP", async () => {
  const fetch = async () => assert.fail("Invalid profile URL must never be fetched");
  for (const value of ["http://agent.example/.well-known/ucp", "https://localhost/.well-known/ucp", "https://127.0.0.1/.well-known/ucp", "https://agent.example/.well-known/ucp?key=secret", "https://agent.example/another-profile"]) {
    assert.deepEqual(await verifyPlatformProfile(value, [], SIGNAL, fetch), { ok: false, reason: "platform_profile_invalid_url" });
  }
  assert.deepEqual(await verifyPlatformProfile(undefined, [], SIGNAL, fetch), { ok: false, reason: "platform_profile_not_configured" });
  assert.deepEqual(await verifyPlatformProfile(URL, ["https://agent.example"], SIGNAL, fetch), { ok: false, reason: "platform_profile_is_merchant" });
});

test("redirect-like responses and missing public deployment are blocked without exposing underlying errors", async () => {
  assert.deepEqual(await verifyPlatformProfile(URL, [], SIGNAL, async () => ({ url: "https://merchant.example/.well-known/ucp", body: createPlatformProfile() })), { ok: false, reason: "platform_profile_mismatch" });
  assert.deepEqual(await verifyPlatformProfile(URL, [], SIGNAL, async () => { throw new Error("secret stack"); }), { ok: false, reason: "platform_profile_unreachable" });
});

test("deployed catalog-only profile differs in both checkout capabilities and payment handlers", async () => {
  const legacy = createPlatformProfile();
  Reflect.deleteProperty(legacy.ucp.capabilities, "dev.ucp.shopping.checkout");
  Reflect.deleteProperty(legacy.ucp.payment_handlers, "com.hashtrion.pay");
  assert.deepEqual(await verifyPlatformProfile(URL, [], SIGNAL, async url => ({ url, body: legacy })), { ok: false, reason: "platform_profile_mismatch" });
  const missingOnlyHandler = createPlatformProfile();
  Reflect.deleteProperty(missingOnlyHandler.ucp.payment_handlers, "com.hashtrion.pay");
  assert.deepEqual(await verifyPlatformProfile(URL, [], SIGNAL, async url => ({ url, body: missingOnlyHandler })), { ok: false, reason: "platform_profile_mismatch" });
});

test("checkout and catalog keep reviewed references and a platform handler independent of merchant IDs", () => {
  const profile = createPlatformProfile();
  const checkout = profile.ucp.capabilities["dev.ucp.shopping.checkout"][0];
  assert.deepEqual(checkout, { version: "2026-08-25", spec: "https://ucp.dev/2026-08-25/specification/shopping/checkout/", schema: "https://ucp.dev/2026-08-25/schemas/shopping/checkout.json" });
  assert.equal(profile.ucp.capabilities[CATALOG_CAPABILITY][0].version, checkout.version);
  assert.equal(profile.ucp.services["dev.ucp.shopping"][0].version, checkout.version);
  const handler = profile.ucp.payment_handlers["com.hashtrion.pay"][0];
  assert.equal(handler.id, "hashtrion_pay");
  for (const merchantId of [handler.id, "other_merchant_hashtrion"]) {
    const merchant = { ...handler, id: merchantId, config: { environment: "sandbox", business_id: `biz_${"a".repeat(32)}` },
      available_instruments: [{ type: "digital_asset", constraints: { properties: { network: { const: "xrpl" }, asset: { enum: ["RLUSD"] } } } }] };
    assert.equal(parsePaymentHandler({ "com.hashtrion.pay": [merchant] }, true)?.id, merchantId,
      "Merchant IDs may be equal to or different from the Platform's own ID");
  }
  assert.equal(handler.version, "2026-10-16");
  assert.deepEqual(handler.available_instruments[0].constraints.properties, { network: { const: "xrpl" } });
});


test("platform handler does not impose a fixed asset list on merchant negotiation", () => {
  const instrument = createPlatformProfile().ucp.payment_handlers["com.hashtrion.pay"][0].available_instruments[0];
  assert.equal(instrument.type, "digital_asset");
  assert.equal("asset" in instrument.constraints.properties, false);
  assert.equal(instrument.constraints.properties.network.const, "xrpl");
});
