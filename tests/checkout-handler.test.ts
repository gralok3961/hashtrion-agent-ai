import assert from "node:assert/strict";
import test from "node:test";
import { applyCheckoutPaymentHandler, parsePaymentHandler, type CheckoutConnection, type PaymentHandler } from "../src/lib/server/checkout";

const profile: PaymentHandler = { name: "com.hashtrion.pay", id: "hashtrion_pay", version: "2026-10-16", spec: "https://www.hashtrion.com/ucp/payment-handlers/com.hashtrion.pay", schema: "https://pay.hashtrion.com/ucp/payment-handlers/com.hashtrion.pay/schema.json", businessId: `biz_${"a".repeat(32)}`, environment: "sandbox", assets: ["XRP", "RLUSD"] };
function connection(): CheckoutConnection {
  return { domain: "merchant.example", endpoint: "https://merchant.example/ucp", platform: "https://agent.example/.well-known/ucp", profileHandler: structuredClone(profile), handler: structuredClone(profile) };
}
function registry(assets = ["RLUSD"]) {
  return { "com.hashtrion.pay": [{ id: profile.id, version: "2026-10-16", config: { business_id: profile.businessId, environment: "sandbox", credential_endpoint: "https://pay.hashtrion.com/api/UcpPayment/issue-credential" }, available_instruments: [{ type: "digital_asset", constraints: { properties: { network: { const: "xrpl" }, asset: { enum: assets } } } }] }] };
}

test("credential endpoint comes from the current checkout handler with no discovery fallback", () => {
  const c = connection();
  c.profileHandler!.credentialEndpoint = "https://platform.example/profile-path";
  const raw = registry();
  Object.assign(raw["com.hashtrion.pay"][0].config, { credential_endpoint: "https://platform.example/checkout-path" });
  applyCheckoutPaymentHandler(c, raw);
  assert.equal(c.handler!.credentialEndpoint, "https://platform.example/checkout-path");
  const missing = registry();
  Reflect.deleteProperty(missing["com.hashtrion.pay"][0].config, "credential_endpoint");
  const before = structuredClone(c);
  assert.throws(() => applyCheckoutPaymentHandler(c, missing), { code: "payment_handler_changed" });
  assert.deepEqual(c, before, "missing required runtime endpoint must not use the profile endpoint");
  for (const value of [null, 123, "", "a".repeat(2049)]) {
    Object.assign(raw["com.hashtrion.pay"][0].config, { credential_endpoint: value });
    assert.equal(parsePaymentHandler(raw), undefined);
  }
});

test("runtime spec/schema may be omitted but cannot replace discovery authority", () => {
  const c = connection();
  applyCheckoutPaymentHandler(c, registry());
  assert.equal(c.handler!.schema, profile.schema);
  assert.equal(c.handler!.spec, profile.spec);
  for (const metadata of [{ schema: "https://hashtrion.com/another-schema.json" }, { spec: "https://other.example/spec" }]) {
    const raw = registry(); Object.assign(raw["com.hashtrion.pay"][0], metadata);
    const before = structuredClone(c);
    assert.throws(() => applyCheckoutPaymentHandler(c, raw), { code: "payment_handler_changed" });
    assert.deepEqual(c, before);
  }
});

test("response handler is authoritative within the immutable discovered asset bound", () => {
  const c = connection(); const raw = registry();
  applyCheckoutPaymentHandler(c, raw);
  assert.deepEqual(c.handler!.assets, ["RLUSD"]);
  assert.deepEqual(c.profileHandler, profile);
  raw["com.hashtrion.pay"][0].available_instruments[0].constraints.properties.asset.enum.push("XRP");
  assert.deepEqual(c.handler!.assets, ["RLUSD"], "response objects cannot mutate stored state");
  applyCheckoutPaymentHandler(c, registry(["RLUSD", "XRP"]));
  assert.deepEqual(c.handler!.assets, ["RLUSD", "XRP"], "later responses are bounded by discovery, not the previous restriction");
  assert.deepEqual(c.profileHandler, profile);
});

for (const fault of ["business", "handler-id", "environment", "version", "network", "instrument", "unknown-asset", "profile-unsupported-asset", "empty-assets", "missing", "untrusted-handler", "multiple", "no-discovered-handler"] as const) {
  test(`reject ${fault} without replacing the last verified checkout handler`, () => {
    const c = connection(); applyCheckoutPaymentHandler(c, registry());
    const raw = registry(), h = raw["com.hashtrion.pay"][0];
    let response: unknown = raw;
    switch (fault) {
      case "business": h.config.business_id = `biz_${"b".repeat(32)}`; break;
      case "handler-id": h.id = "other"; break;
      case "environment": h.config.environment = "production"; break;
      case "version": h.version = "unsupported"; break;
      case "network": h.available_instruments[0].constraints.properties.network.const = "other"; break;
      case "instrument": h.available_instruments[0].type = "card"; break;
      case "unknown-asset": h.available_instruments[0].constraints.properties.asset.enum = ["BTC"]; break;
      case "profile-unsupported-asset": c.profileHandler!.assets = ["XRP"]; break;
      case "empty-assets": h.available_instruments[0].constraints.properties.asset.enum = []; break;
      case "missing": response = {}; break;
      case "untrusted-handler": response = { "com.other.pay": [h] }; break;
      case "multiple": raw["com.hashtrion.pay"].push(structuredClone(h)); break;
      case "no-discovered-handler": delete c.profileHandler; break;
    }
    const before = structuredClone(c);
    assert.throws(() => applyCheckoutPaymentHandler(c, response), { code: "payment_handler_changed" });
    assert.deepEqual(c, before);
  });
}

test("merchants without a supported discovered handler cannot acquire one from checkout", () => {
  const c = connection(); delete c.profileHandler; delete c.handler;
  applyCheckoutPaymentHandler(c, {});
  assert.equal(c.handler, undefined);
  assert.throws(() => applyCheckoutPaymentHandler(c, registry()), { code: "payment_handler_changed" });
});


test("asset validation is data-driven, bounded, and preserves exact merchant identifiers", () => {
  const c = connection();
  const assets = ["EURC", "USD.C+1"];
  c.profileHandler = parsePaymentHandler(registry(assets));
  assert.deepEqual(c.profileHandler?.assets, assets);
  applyCheckoutPaymentHandler(c, registry(["USD.C+1"]));
  assert.deepEqual(c.handler?.assets, ["USD.C+1"]);
  assert.throws(() => applyCheckoutPaymentHandler(c, registry(["RLUSD"])), { code: "payment_handler_changed" });
  for (const invalid of [[""], ["EURC\n"], [" EURC"], ["a".repeat(129)], Array(257).fill("EURC"), [123], [null], [{ asset: "EURC" }]]) {
    assert.equal(parsePaymentHandler(registry(invalid as string[])), undefined);
  }
});
