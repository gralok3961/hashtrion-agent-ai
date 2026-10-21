import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, createHash, verify, randomUUID } from "node:crypto";
import { httpbis } from "http-message-signatures";
import { createUcpSigner, UcpSigningError } from "../src/lib/server/ucp-signature";
import { createSafeHttpClient, SafeFetchError } from "../src/lib/server/safe-http";
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = pair.publicKey.export({ format: "jwk" });
const encoded = Buffer.from(pair.privateKey.export({ format: "pem", type: "pkcs8" })).toString("base64");
const signer = createUcpSigner(() => encoded, jwk);
const headers = { "UCP-Agent": 'profile="https://agent.example/.well-known/ucp"', "Request-Id": randomUUID(), "Idempotency-Key": randomUUID(), "Content-Type": "application/json" };

test("all REST checkout methods and catalog sign exact UTF-8 bytes with 64-byte ES256 and identity coverage", async () => {
  for (const [method, path] of [["POST", "/catalog/search"], ["POST", "/checkout-sessions"], ["GET", "/checkout-sessions/c1"], ["PUT", "/checkout-sessions/c1"], ["POST", "/checkout-sessions/c1/cancel"], ["POST", "/checkout-sessions/c1/complete"]]) {
    const body = method === "GET" ? undefined : Buffer.from('{ "title": "café", "quantity": 2 }');
    const url = new URL(`https://merchant.example/ucp/v1${path}?a=one%20two&a=three`);
    const inputHeaders = method === "GET" ? { "Request-Id": headers["Request-Id"], "UCP-Agent": headers["UCP-Agent"] } : headers;
    const result = await signer({ method, url, body, headers: inputHeaders, required: true });
    assert.match(result["Signature-Input"], /keyid="shopping-agent"/);
    assert.ok(!result["Signature-Input"].includes(";alg="));
    assert.equal(Buffer.from(result.Signature.split(":")[1], "base64").length, 64);
    const requiredFields = ["@method", "@authority", "@path", "@query", "ucp-agent", "request-id", ...(body ? ["content-digest", "content-type", "idempotency-key"] : [])];
    assert.equal(await httpbis.verifyMessage({ requiredFields, keyLookup: async () => ({ verify: async (data, signature) => verify("sha256", data, { key: pair.publicKey, dsaEncoding: "ieee-p1363" }, signature) }) }, { method, url, headers: { ...inputHeaders, ...result } }), true);
    assert.equal(result["Content-Digest"], body ? `sha-256=:${createHash("sha256").update(body).digest("base64")}:` : undefined);
  }
});
test("missing, malformed, wrong-curve and mismatched keys fail safely; only public catalog can be unsigned", async () => {
  const request = { method: "GET", url: new URL("https://merchant.example/checkout-sessions/c1"), headers, required: true };
  for (const value of [undefined, "not base64", Buffer.from("invalid pem").toString("base64")]) {
    await assert.rejects(createUcpSigner(() => value, jwk)(request), UcpSigningError);
  }
  const wrong = generateKeyPairSync("ec", { namedCurve: "P-384" });
  await assert.rejects(createUcpSigner(() => Buffer.from(wrong.privateKey.export({ format: "pem", type: "pkcs8" })).toString("base64"), jwk)(request), UcpSigningError);
  await assert.rejects(createUcpSigner(() => encoded, { ...jwk, x: "wrong" })(request), UcpSigningError);
  assert.deepEqual(await createUcpSigner(() => undefined, jwk)({ ...request, required: false }), {});
});
test("missing checkout signing blocks before DNS or HTTP; discovery fetch is never signed", async () => {
  const client = createSafeHttpClient({ sign: createUcpSigner(() => undefined, jwk), resolve: async () => assert.fail("No DNS"), request: () => assert.fail("No HTTP") });
  for (const method of ["GET", "POST", "PUT"] as const) {
    await assert.rejects(client.requestUcpJson("https://merchant.example/ucp/v1/checkout-sessions/c1", method, {}, headers), (e: unknown) => e instanceof SafeFetchError && e.code === "signing_not_configured");
  }
});
