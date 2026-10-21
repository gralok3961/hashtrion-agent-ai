// Local operator-only integration check; never imported by the application.
// Run from the repository root:
// node --env-file=.env --import tsx scripts/check-platform-ucp-auth.ts
// Uses the existing local UCP_SIGNING_PRIVATE_KEY_BASE64. Never prints keys or request headers.
import { randomUUID } from "node:crypto";
import { createPlatformProfile } from "../src/lib/server/platform-profile";
import { signUcpRequest, UcpSigningError } from "../src/lib/server/ucp-signature";

const ENDPOINT =
  "https://ac-platformapi-gaf2ade0cqfmd7ed.australiasoutheast-01.azurewebsites.net/api/UcpPayment/issue-credential";
const PROFILE_URL =
  "https://hackathon-agent-ai-aycdcseeepbpctb9.australiasoutheast-01.azurewebsites.net/.well-known/ucp";
const MAX_RESPONSE_BYTES = 128 * 1024;

class CheckError extends Error {}

async function readBody(response: Response): Promise<string> {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new CheckError("Response exceeded the 128 KiB limit; body was not printed.");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}

async function verifyPublishedKey(): Promise<void> {
  const response = await fetch(PROFILE_URL, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new CheckError(`Public profile returned HTTP ${response.status}; POST was not sent.`);
  }

  const document = JSON.parse(await readBody(response));
  const expected = createPlatformProfile().keys[0];
  const keys: Record<string, unknown>[] = Array.isArray(document?.keys)
    ? document.keys.filter(
        (key: unknown) => key !== null && typeof key === "object" && !Array.isArray(key)
      )
    : [];
  const matches = keys.filter((key) => key.kid === expected.kid);
  const key = matches[0];
  if (
    matches.length !== 1 ||
    key.kty !== expected.kty ||
    key.crv !== expected.crv ||
    key.x !== expected.x ||
    key.y !== expected.y ||
    "d" in key ||
    (key.alg !== undefined && key.alg !== "ES256") ||
    (key.use !== undefined && key.use !== "sig")
  ) {
    throw new CheckError(
      "Published shopping-agent key does not match the existing signer; POST was not sent."
    );
  }
}

async function main() {
  const body = Buffer.from("{}", "utf8");
  const headers = {
    "UCP-Agent": `profile="${PROFILE_URL}"`,
    "Request-Id": randomUUID(),
    "Idempotency-Key": randomUUID(),
    "Content-Type": "application/json",
  };

  // Validate the local key without printing it, then verify the published identity.
  // Sign again after discovery so network latency does not consume the validity window.
  const request = { url: new URL(ENDPOINT), method: "POST", headers, body, required: true };
  await signUcpRequest(request);
  await verifyPublishedKey();
  const signedHeaders = await signUcpRequest(request);
  console.log("Local signing key matches the published shopping-agent public key.");

  // Exactly one POST; no redirects or automatic application-level retries.
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { ...headers, ...signedHeaders },
    body: body.toString("utf8"),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  console.log(`HTTP ${response.status}`);
  const responseBody = await readBody(response);
  const encodedKey = process.env.UCP_SIGNING_PRIVATE_KEY_BASE64;
  if (
    (encodedKey && responseBody.includes(encodedKey)) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(responseBody)
  ) {
    throw new CheckError("Response body was withheld because it contains private key material.");
  }
  console.log(JSON.stringify({ body: responseBody }, null, 2));
  if (!response.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  // Never print raw exceptions: dependencies may include request or credential data.
  const message =
    error instanceof UcpSigningError
      ? error.code
      : error instanceof CheckError
        ? error.message
        : "Integration check failed while reading the profile or making the request; no raw diagnostic data was printed.";
  console.error(message);
  process.exitCode = 1;
});
