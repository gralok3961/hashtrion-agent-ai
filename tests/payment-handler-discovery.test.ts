import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyCheckoutPaymentHandler, type CheckoutConnection } from "../src/lib/server/checkout";
import { assertCredentialEndpointIdentity, parsePaymentHandler } from "../src/lib/server/payment-handler-discovery";
import { prepareHashtrionCredentialRequest } from "../src/lib/server/payment-adapter";
import { createCredentialIssuer, type CredentialContext } from "../src/lib/server/payment";
import { SafeFetchError, type fetchPublicJson } from "../src/lib/server/safe-http";

// Bluefern handler metadata adapted to the Hackathon credential endpoint.
// Checkout responses are simulated here; unit tests never call a live service.
const bluefern = JSON.parse(readFileSync(new URL("./fixtures/bluefern-payment-handler.json", import.meta.url), "utf8"));
const now = Date.parse("2026-10-13T00:00:00Z");
const metadataUrl = "https://pay.hashtrion.com/ucp/payment-handlers/com.hashtrion.pay/credential-endpoints.json";
const azureEndpoint = bluefern["com.hashtrion.pay"][0].config.credential_endpoint;
const authorization = () => ({ version: 1, handler: "com.hashtrion.pay", handler_version: "2026-10-16",
  credential_endpoints: { sandbox: [azureEndpoint], production: [] } });

test("Bluefern runtime endpoint is authorized by a separate provider GET before the existing signed issuance request", async () => {
  const discovered = parsePaymentHandler(bluefern, true)!;
  assert.ok(discovered);
  const connection: CheckoutConnection = { domain: "bluefern.shop", endpoint: "https://api.bluefern.shop/ucp/v1", platform: "https://agent.example/.well-known/ucp", profileHandler: discovered };
  // Discovery's endpoint is a hint; response_config is the authoritative source.
  delete discovered.credentialEndpoint;
  const checkoutResponse = structuredClone(bluefern);
  delete checkoutResponse["com.hashtrion.pay"][0].schema;
  delete checkoutResponse["com.hashtrion.pay"][0].spec;
  applyCheckoutPaymentHandler(connection, checkoutResponse);
  const context: CredentialContext = { connection, agentId: `agt_${"A".repeat(26)}`, asset: "RLUSD", idempotencyKey: "k".repeat(32), signal: new AbortController().signal,
    checkout: { id: "synthetic_bluefern_checkout", merchant: "bluefern.shop", status: "ready_for_complete", currency: "USD", total: 400, expiresAt: "2026-10-13T00:10:00Z", items: [], errors: [] } };
  assert.deepEqual(prepareHashtrionCredentialRequest(context, now), {
    endpoint: checkoutResponse["com.hashtrion.pay"][0].config.credential_endpoint,
    body: { agentPublicId: context.agentId, businessId: discovered.businessId, checkoutId: context.checkout.id },
  });
  const operations: string[] = [];
  const credential = { type: "hashtrion_authorization", token: "synthetic-token", expiry: "2026-10-13T00:05:00Z" };
  const issue = createCredentialIssuer(async (url, method, body, _headers, _signal, policy) => {
    operations.push("issue");
    assert.equal(url, azureEndpoint);
    assert.equal(method, "POST");
    assert.deepEqual(body, { agentPublicId: context.agentId, businessId: discovered.businessId, checkoutId: context.checkout.id });
    assert.deepEqual(policy, { requireSignature: true, discardErrorBody: true, timeoutPolicy: "issue_credential" });
    return { url, status: 200, body: credential };
  }, () => now, async (...args) => {
    operations.push("provider-metadata");
    assert.deepEqual(args, [metadataUrl, context.signal], "metadata GET receives no request body, identity headers or secrets");
    return { url: args[0], body: authorization() };
  });
  assert.deepEqual(await issue(context), credential);
  assert.deepEqual(operations, ["provider-metadata", "issue"]);
  context.connection.handler!.credentialEndpoint = "https://arbitrary.example/api/UcpPayment/issue-credential";
  await assert.rejects(issue(context), { code: "credential_endpoint_untrusted" });
  assert.deepEqual(operations, ["provider-metadata", "issue", "provider-metadata"], "arbitrary endpoints never reach signing");
});

test("provider metadata is required even for the schema origin, and authorization is environment-specific", async () => {
  for (const patch of [{ environment: "production" as const }, { credentialEndpoint: "https://pay.hashtrion.com/api/UcpPayment/issue-credential" }]) {
    const handler = { ...parsePaymentHandler(bluefern, true)!, ...patch };
    await assert.rejects(assertCredentialEndpointIdentity(handler, undefined, async url => ({ url, body: authorization() })), { code: "credential_endpoint_untrusted" });
  }
});

test("untrusted schema authority fails before any provider fetch, and schema path cannot select another metadata document", async () => {
  const handler = parsePaymentHandler(bluefern, true)!; let calls = 0;
  const fetch: typeof fetchPublicJson = async url => { calls++; assert.equal(url, metadataUrl); return { url, body: authorization() }; };
  for (const schema of ["https://evil.example/schema.json", "https://pay.hashtrion.com.evil.example/schema.json", "https://127.0.0.1/schema.json"]) {
    await assert.rejects(assertCredentialEndpointIdentity({ ...handler, schema }, undefined, fetch), { code: "credential_endpoint_untrusted" });
  }
  assert.equal(calls, 0);
  await assertCredentialEndpointIdentity({ ...handler, schema: "https://pay.hashtrion.com/merchant-upload/other.json" }, undefined, fetch);
  assert.equal(calls, 1);
});

test("missing, malformed, mismatched and unsafe provider authorization metadata fails closed", async () => {
  const handler = parsePaymentHandler(bluefern, true)!;
  const documents: unknown[] = [null, [], {}, "invalid", { ...authorization(), version: 2 }, { ...authorization(), handler: "com.other.pay" },
    { ...authorization(), handler_version: "2099-01-01" }, { ...authorization(), credential_endpoints: [] },
    { ...authorization(), credential_endpoints: { sandbox: azureEndpoint, production: [] } },
    { ...authorization(), credential_endpoints: { sandbox: [], production: [] } },
    { ...authorization(), credential_endpoints: { sandbox: [azureEndpoint] } }];
  for (const invalid of ["http://api.example/api/UcpPayment/issue-credential", "https://127.0.0.1/api/UcpPayment/issue-credential", "https://user:pass@api.example/api/UcpPayment/issue-credential", `${azureEndpoint}?redirect=x`, `${azureEndpoint}#fragment`, azureEndpoint.replace("issue-credential", "process-payment"), azureEndpoint.replace("/api/", "/other/../api/"), 123, null]) {
    documents.push({ ...authorization(), credential_endpoints: { sandbox: [azureEndpoint, invalid], production: [] } });
  }
  documents.push({ ...authorization(), credential_endpoints: { sandbox: Array(17).fill(azureEndpoint), production: [] } });
  for (const body of documents) {
    await assert.rejects(assertCredentialEndpointIdentity(handler, undefined, async url => ({ url, body })), { code: "credential_endpoint_untrusted" });
  }
});

test("provider fetch errors, redirect-like responses and revocation never fall back to prior authorization", async () => {
  const handler = parsePaymentHandler(bluefern, true)!;
  for (const code of ["unsafe_url", "timeout", "not_found", "http_error", "invalid_json", "too_large"] as const) {
    await assert.rejects(assertCredentialEndpointIdentity(handler, undefined, async () => { throw new SafeFetchError(code); }), { code: "credential_endpoint_untrusted" });
  }
  await assert.rejects(assertCredentialEndpointIdentity(handler, undefined, async () => ({ url: "https://evil.example/metadata.json", body: authorization() })), { code: "credential_endpoint_untrusted" });
  let calls = 0;
  const fetch: typeof fetchPublicJson = async url => {
    calls++;
    const body = authorization();
    if (calls > 1) body.credential_endpoints.sandbox = [];
    return { url, body };
  };
  await assertCredentialEndpointIdentity(handler, undefined, fetch);
  await assert.rejects(assertCredentialEndpointIdentity(handler, undefined, fetch), { code: "credential_endpoint_untrusted" });
  assert.equal(calls, 2);
});

test("merchant-scoped handler IDs are selected from discovery and matched in checkout", () => {
  for (const id of ["hashtrion_pay", "merchant_b_hashtrion", "payments:tenant-42"]) {
    const raw = structuredClone(bluefern); raw["com.hashtrion.pay"][0].id = id;
    const profileHandler = parsePaymentHandler(raw, true);
    assert.equal(profileHandler?.id, id);
    const connection: CheckoutConnection = { domain: "merchant.example", endpoint: "https://merchant.example/ucp", platform: "https://agent.example/.well-known/ucp", profileHandler };
    applyCheckoutPaymentHandler(connection, raw);
    assert.equal(connection.handler?.id, id);
    raw["com.hashtrion.pay"][0].id = "different_from_this_merchants_discovery";
    assert.throws(() => applyCheckoutPaymentHandler(connection, raw), { code: "payment_handler_changed" });
  }
});

test("discovery requires the supported adapter, an unambiguous instance, HTTPS spec and namespace-bound schema", () => {
  assert.equal(parsePaymentHandler({ "com.unknown.pay": bluefern["com.hashtrion.pay"] }, true), undefined);
  assert.equal(parsePaymentHandler({ "com.hashtrion.pay": [...bluefern["com.hashtrion.pay"], ...bluefern["com.hashtrion.pay"]] }, true), undefined);
  for (const metadata of [{ id: "" }, { version: "2099-01-01" }, { schema: undefined }, { spec: undefined }, { spec: "http://www.hashtrion.com/spec" }, { schema: "https://www.hashtrion.com/schema.json" }, { schema: "https://pay.hashtrion.com.evil.example/schema.json" }, { schema: "https://pay.hashtrion.com@evil.example/schema.json" }, { schema: "https://127.0.0.1/schema.json" }]) {
    const raw = structuredClone(bluefern); Object.assign(raw["com.hashtrion.pay"][0], metadata);
    assert.equal(parsePaymentHandler(raw, true), undefined);
  }
  const otherDocs = structuredClone(bluefern);
  otherDocs["com.hashtrion.pay"][0].spec = "https://docs.example/handler";
  assert.ok(parsePaymentHandler(otherDocs, true), "UCP binds schema authority, not the documentation host");
});
