import assert from "node:assert/strict";
import test from "node:test";
import { createCredentialIssuer, validCredential, type CredentialContext } from "../src/lib/server/payment";
import { SafeFetchError, type requestUcpJson, type fetchPublicJson } from "../src/lib/server/safe-http";

const now = Date.parse("2026-10-13T00:00:00Z");
// Injected transport only: this is a namespace-owned synthetic deployment, not a live API.
const endpoint = "https://pay.hashtrion.com/api/UcpPayment/issue-credential";
const origin = new URL(endpoint).origin;
const credential = { type: "hashtrion_authorization", token: "synthetic-token", expiry: "2026-10-13T00:05:00Z" };
const fetchAuthorization: typeof fetchPublicJson = async url => ({ url, body: {
  version: 1, handler: "com.hashtrion.pay", handler_version: "2026-10-16",
  credential_endpoints: { sandbox: [endpoint], production: [] },
} });
function context(): CredentialContext {
  const c: CredentialContext = { agentId: `agt_${"A".repeat(26)}`, asset: "RLUSD", idempotencyKey: "a".repeat(32), signal: new AbortController().signal,
    connection: { domain: "merchant.example", endpoint: "https://merchant.example/ucp", platform: "https://agent.example/.well-known/ucp",
      handler: { name: "com.hashtrion.pay", id: "merchant_specific_id", version: "2026-10-16", schema: "https://pay.hashtrion.com/ucp/payment-handlers/com.hashtrion.pay/schema.json", spec: "https://www.hashtrion.com/ucp/payment-handlers/com.hashtrion.pay", businessId: `biz_${"a".repeat(32)}`, assets: ["RLUSD"], environment: "sandbox", credentialEndpoint: endpoint } },
    checkout: { id: "checkout_actual", merchant: "merchant.example", status: "ready_for_complete", currency: "USD", total: 400, expiresAt: "2026-10-13T00:15:00Z", items: [], errors: [] } };
  c.connection.profileHandler = structuredClone(c.connection.handler);
  return c;
}
function fixture(body: unknown = credential, status = 200) {
  const calls: Parameters<typeof requestUcpJson>[] = [];
  const issue = createCredentialIssuer(async (...args) => { calls.push(args); return { status, body, url: args[0] }; }, () => now, fetchAuthorization);
  return { issue, calls };
}

test("credential acquisition uses verified handler endpoint/business, actual checkout and selected Agent with mandatory existing signer", async () => {
  const f = fixture({ ...credential, extra: "never-retained" }); const c = context();
  assert.deepEqual(await f.issue(c), credential);
  assert.equal(f.calls.length, 1);
  const [url, method, body, headers, signal, policy] = f.calls[0];
  assert.equal(url, c.connection.handler!.credentialEndpoint);
  assert.equal(method, "POST");
  assert.deepEqual(body, { agentPublicId: c.agentId, businessId: c.connection.handler!.businessId, checkoutId: c.checkout.id });
  assert.equal(headers["UCP-Agent"], `profile="${c.connection.platform}"`);
  assert.equal(headers["Idempotency-Key"], c.idempotencyKey);
  assert.match(headers["Request-Id"], /^[a-f0-9-]{36}$/);
  assert.equal(signal, c.signal);
  assert.deepEqual(policy, { requireSignature: true, discardErrorBody: true, timeoutPolicy: "issue_credential" });
});

for (const discoveredEndpoint of [undefined, "", "http://platform.example/issue", "https://evil.example/issue", "https://platform.example.evil.example/issue", "https://platform.example:444/issue", "https://user:pass@platform.example/issue", "https://platform.example/issue#fragment", "https://platform.example/issue?redirect=elsewhere", "https://127.0.0.1/issue", `${origin}/api/UcpPayment/process-payment`, `${endpoint}/`, `${endpoint}?redirect=elsewhere`, endpoint.replace("/api/", "/wrong/../api/"), endpoint.replace("https:", "http:")]) {
  test(`reject endpoint ${discoveredEndpoint} before transport/signing`, async () => {
    const f = fixture(); const c = context(); c.connection.handler!.credentialEndpoint = discoveredEndpoint;
    await assert.rejects(f.issue(c), { code: "credential_endpoint_untrusted" });
    assert.equal(f.calls.length, 0);
  });
}
test("unsupported handler names and versions cannot invoke an adapter", async () => {
  for (const field of ["name", "version"] as const) {
    const f = fixture(); const c = context(); c.connection.handler![field] = "unregistered";
    await assert.rejects(f.issue(c), { code: "payment_provider_unsupported" });
    assert.equal(f.calls.length, 0);
  }
});

test("a changed merchant handler ID or missing discovery cannot invoke the issuer", async () => {
  for (const mutate of [(c: CredentialContext) => { c.connection.handler!.id = "not_discovered"; }, (c: CredentialContext) => { delete c.connection.profileHandler; }]) {
    const f = fixture(); const c = context(); mutate(c);
    await assert.rejects(f.issue(c), { code: "payment_handler_changed" });
    assert.equal(f.calls.length, 0);
  }
});

test("different valid merchant IDs use the same adapter without a global ID allowlist", async () => {
  for (const id of ["hashtrion_pay", "merchant_payment_2", "tenant-42:hashtrion"]) {
    const f = fixture(); const c = context();
    c.connection.handler!.id = id; c.connection.profileHandler!.id = id;
    assert.deepEqual(await f.issue(c), credential);
    assert.equal(f.calls.length, 1);
  }
});

test("matching malicious discovery and checkout metadata cannot authorize an unrelated provider", async () => {
  for (const schema of [undefined, "https://evil.example/schema.json", "https://pay.hashtrion.com.evil.example/schema.json", "https://93.184.216.34/schema.json", "https://com/schema.json"]) {
    const f = fixture(); const c = context();
    c.connection.handler!.schema = schema; c.connection.profileHandler!.schema = schema;
    await assert.rejects(f.issue(c), { code: "credential_endpoint_untrusted" });
    assert.equal(f.calls.length, 0);
  }
});

for (const body of [null, [], {}, { ...credential, type: "card" }, { ...credential, token: "" }, { ...credential, token: " " }, { ...credential, token: "a\nb" }, { ...credential, token: 123 }, { ...credential, token: "x".repeat(8193) }, { ...credential, expiry: "not-a-date" }, { ...credential, expiry: "2026-10-13" }, { ...credential, expiry: "2026-10-12T23:59:59Z" }, { ...credential, expiry: "2026-10-13T00:00:05Z" }]) {
  test(`reject invalid credential response case ${typeof body === "object" && body ? Object.keys(body).join(",") : String(body)}`, async () => {
    const f = fixture(body);
    await assert.rejects(f.issue(context()), { code: "credential_invalid" });
    if (!(body && typeof body === "object" && "type" in body && body.type === "card")) assert.equal(validCredential(body, now), false);
  });
}

for (const [status, code] of [[400, "credential_bad_request"], [401, "credential_unauthorized"], [403, "credential_forbidden"], [500, "credential_service_unavailable"], [429, "credential_request_failed"], [201, "credential_request_failed"]] as const) {
  test(`HTTP ${status} produces only a safe error, never reflects upstream body`, async () => {
    const f = fixture({ token: "synthetic-secret", message: "synthetic-private-error" }, status);
    await assert.rejects(f.issue(context()), error => error instanceof Error && error.message === code && !JSON.stringify(error).includes("synthetic-"));
  });
}
test("redirect, timeout, malformed JSON and arbitrary transport exceptions remain safe without retry", async () => {
  for (const error of [new SafeFetchError("unsafe_url"), new SafeFetchError("timeout"), new SafeFetchError("invalid_json"), new Error("synthetic-secret")]) {
    let calls = 0;
    const issue = createCredentialIssuer(async () => { calls++; throw error; }, () => now, fetchAuthorization);
    await assert.rejects(issue(context()), { code: "credential_request_failed" });
    assert.equal(calls, 1);
  }
});
test("missing signing configuration is retained as a safe actionable error", async () => {
  const issue = createCredentialIssuer(async () => { throw new SafeFetchError("signing_not_configured"); }, () => now, fetchAuthorization);
  await assert.rejects(issue(context()), { code: "signing_not_configured" });
});

test("runtime handler changes while provider authorization is fetched cannot reach signing", async () => {
  const c = context(); let calls = 0;
  const issue = createCredentialIssuer(async () => { calls++; assert.fail("Changed endpoint must not be signed"); }, () => now, async url => {
    c.connection.handler!.credentialEndpoint = "https://arbitrary.example/api/UcpPayment/issue-credential";
    return fetchAuthorization(url);
  });
  await assert.rejects(issue(c), { code: "payment_handler_changed" });
  assert.equal(calls, 0);
});
test("invalid Agent, expired checkout, merchant mismatch and unsupported asset fail before issuance", async () => {
  for (const mutate of [(c: CredentialContext) => { c.agentId = "invalid"; }, (c: CredentialContext) => { c.checkout.expiresAt = "2026-10-12T00:00:00Z"; }, (c: CredentialContext) => { c.checkout.merchant = "other.example"; }, (c: CredentialContext) => { c.asset = "XRP"; }]) {
    const f = fixture(); const c = context(); mutate(c);
    await assert.rejects(f.issue(c), { code: "payment_context_required" });
    assert.equal(f.calls.length, 0);
  }
});
