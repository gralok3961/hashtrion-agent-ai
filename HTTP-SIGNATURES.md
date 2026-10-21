# UCP REST request signing

The shared `src/lib/server/safe-http.ts` client signs outgoing UCP REST requests using
`src/lib/server/ucp-signature.ts`. MCP transport is unchanged. JSON is serialized once;
the exact UTF-8 bytes are both hashed and sent. `http-message-signatures` 1.0.6 handles
RFC 9421 components and Structured Fields. Node crypto produces ES256 SHA-256 signatures
in fixed-width 64-byte IEEE P1363 (r||s) format, not DER.

The signer covers method, authority, path, query when present, UCP-Agent, Request-Id,
idempotency key when present/required, and body digest/content type. Existing Checkout
idempotency keys are preserved. Other non-GET UCP requests receive a UUID when missing.
Only public signature headers leave the server; private keys never enter model context.

## Configuration

Keep the existing public HTTPS `UCP_PLATFORM_PROFILE_URL`. In the trusted runtime only,
configure `UCP_SIGNING_PRIVATE_KEY_BASE64` with the existing Base64 PEM from the Azure
secret setting. Do not copy the production key into local files or test fixtures.
The derived public key must match the published P-256 `shopping-agent` JWK. Missing or
invalid configuration stops Checkout before network dispatch with a safe error.
Without a configured key, public Catalog remains unsigned; a malformed configured key
fails rather than silently falling back. Profile discovery itself is not signed.

Both published public-key arrays remain unchanged. UCP 2026-08-25 discovers keys from
`keys[]`; `signing_keys[]` remains a compatibility alias, not an alternative trust source.

## Standards and local policy

See [UCP signatures](https://ucp.dev/2026-08-25/specification/signatures/),
[Overview](https://ucp.dev/2026-08-25/specification/overview/),
[RFC 9421](https://www.rfc-editor.org/rfc/rfc9421), and
[RFC 9530](https://www.rfc-editor.org/rfc/rfc9530).

The signed components, body digest, profile key discovery and raw ES256 encoding follow
UCP REST. Signing Request-Id and including created/expires with a five-minute validity
window are Hashtrion policies. Freshness is not a mandatory UCP replay mechanism;
Merchant persistent caller-bound idempotency remains authoritative. This implementation
supports default UCP REST signatures, not WBA/AP2. No HTTP signing was added to MCP.

## Validation and rollout

`npm test`, `npm run lint`, `npx tsc --noEmit --incremental false`, `npm run build`.
Tests use ephemeral keys, exact-wire-byte assertions, missing/mismatched key rejection,
and a stolen conversation ID from another authenticated chat session. The Merchant
suite launches `scripts/signature-test-peer.ts` to verify this production signer in .NET.
No production credentials, OpenAI calls, blockchain payments or deployment are tested.

1. Deploy this Agent first with its existing signing secret and public profile configured.
2. In the trusted deployed runtime, verify a non-payment Catalog/Create/Get/Update/Cancel
   flow reaches the existing Merchant. Inspect only signature-header presence and status;
   never enable raw body, credential or private-key logging. Do not invoke Complete.
3. Apply the additive Merchant ownership migration and configure its trusted profile and
   public origin, following the Merchant `HTTP-SIGNATURES.md` instructions.
4. Deploy Merchant verification; Checkout authentication is mandatory immediately, with
   no compatibility bypass. Existing unowned Checkout rows cannot be claimed. Begin new
   Checkout sessions after cutover; resolve older sessions before rollout.
5. Repeat the safe lifecycle and negative checks described in the Merchant document.

IssueCredential uses this same signer with signatures mandatory for the endpoint from the current Checkout's `com.hashtrion.pay` configuration. Merchant discovery selects the supported adapter and Merchant-local handler ID; Checkout must match that discovered identity, version, Business, environment and instrument constraints. Runtime spec/schema may be omitted and inherited from discovery, but cannot replace it. The endpoint is required in Checkout and never falls back to discovery. There is no provider URL registry or global Merchant handler ID mapping; the ID in this App's public profile belongs only to the Platform.

Before signing, the App validates the schema's UCP namespace authority, then fetches `/ucp/payment-handlers/com.hashtrion.pay/credential-endpoints.json` from that schema origin using an unsigned public GET. The fixed metadata path is part of the Hashtrion adapter contract; Merchant config, schema paths, documentation URLs and credential hosts cannot override it. UCP authority binding applies to the schema, not the credential API origin. The provider's HTTPS authorization document permits a separate Azure API origin without hardcoding it in this App.

This handler-specific document uses `version: 1`, `handler`, `handler_version` and `credential_endpoints: { sandbox: string[], production: string[] }`. The handler/version must match the reviewed adapter. Each environment lists at most 16 exact, canonical HTTPS URLs; an empty list denies issuance. The Checkout endpoint must exactly match an entry for its environment, including the path. The adapter still limits the operation to `/api/UcpPayment/issue-credential`, with no query, fragment, userinfo or normalization tricks. A provider-owned origin alone no longer bypasses explicit authorization. Metadata is fetched before each issuance attempt without an in-process cache; a failed fetch, redirect, invalid document or missing authorization blocks with `credential_endpoint_untrusted`. Runtime handler changes during the fetch also block issuance.

Both metadata GET and credential POST retain DNS pinning, special-use address rejection, TLS verification, time/size limits and redirect blocking in `safe-http.ts`. The metadata GET sends no signature, Agent ID, Business ID, Checkout ID or credential. HTTP Signature on the subsequent POST authenticates the sender; provider-controlled metadata authorizes the receiver. The endpoint continues to come from Checkout, not from selecting or substituting a URL from the metadata.

**Publication prerequisite:** The Website project contains the provider document at `public/ucp/payment-handlers/com.hashtrion.pay/credential-endpoints.json`, authorizing the existing Azure URL for sandbox only. Publish that file on `pay.hashtrion.com` before enabling this Agent change in a deployed environment. Until it is available directly over HTTPS without a redirect, issuance remains blocked. These changes do not deploy either project or issue credentials.

The request body remains `{ agentPublicId, businessId, checkoutId }`, sourced from the selected Agent and validated Checkout. The response must be `hashtrion_authorization` with a nonempty token and unexpired ISO datetime. Confirm Purchase consumes the confirmation token and re-fetches Checkout before issuance. Successful credentials stay in owner-bound server conversation state, excluded from browser/model projections and ordinary serialization. Signing private keys remain in the existing server environment variable. The orchestration stops after issuance (Step 2); it does not call Complete Checkout, ProcessPayment or payment settlement. Future Step 3 belongs immediately after issuance in the same confirmed server operation.
Agent conversation state/rate limits retain their existing process-local limitations.

## Files changed in this implementation

- `.env.local.example`
- `HTTP-SIGNATURES.md`
- `README.md`
- `package-lock.json`
- `package.json`
- `scripts/signature-test-peer.ts`
- `src/lib/server/checkout.ts`
- `src/lib/server/safe-http.ts`
- `src/lib/server/shopping-orchestrator.ts`
- `src/lib/server/ucp-signature.ts`
- `tests/chat-route-auth.test.ts`
- `tests/safe-http.test.ts`
- `tests/ucp-signature.test.ts`
