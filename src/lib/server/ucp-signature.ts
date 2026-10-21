import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { httpbis } from "http-message-signatures";
import { createPlatformProfile } from "./platform-profile";

export class UcpSigningError extends Error {
  constructor(public readonly code: "signing_not_configured" | "signing_invalid_configuration") {
    super(code);
  }
}
export type SigningRequest = {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
  required: boolean;
};

/** Credentials are read only on the server when sending a request; tests inject ephemeral keys. */
export function createUcpSigner(
  readKey: () => string | undefined,
  publicKey: JsonWebKey,
  now = Date.now
) {
  return async ({
    url,
    method,
    headers,
    body,
    required,
  }: SigningRequest): Promise<Record<string, string>> => {
    const encoded = readKey();
    if (!encoded) {
      if (required) {
        throw new UcpSigningError("signing_not_configured");
      }
      return {};
    }
    let key;
    let pem: Buffer | undefined;
    try {
      if (
        encoded.length > 8192 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
      ) {
        throw new Error();
      }
      pem = Buffer.from(encoded, "base64");
      key = createPrivateKey({ key: pem, format: "pem" });
      const actual = createPublicKey(key).export({ format: "jwk" });
      if (
        actual.kty !== "EC" ||
        actual.crv !== "P-256" ||
        actual.x !== publicKey.x ||
        actual.y !== publicKey.y
      ) {
        throw new Error();
      }
    } catch {
      throw new UcpSigningError("signing_invalid_configuration");
    } finally {
      pem?.fill(0);
    }
    try {
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        !headers["UCP-Agent"] ||
        !headers["Request-Id"]
      ) {
        throw new Error();
      }
      const fields = [
        "@method",
        "@authority",
        "@path",
        ...(url.search ? ["@query"] : []),
        "ucp-agent",
        "request-id",
      ];
      if (!["GET", "HEAD"].includes(method)) {
        if (!headers["Idempotency-Key"]) {
          throw new Error();
        }
        fields.push("idempotency-key");
      } else if (headers["Idempotency-Key"]) {
        fields.push("idempotency-key");
      }
      const digest: Record<string, string> = body
        ? { "Content-Digest": `sha-256=:${createHash("sha256").update(body).digest("base64")}:` }
        : {};
      if (body) {
        if (headers["Content-Type"] !== "application/json") {
          throw new Error();
        }
        fields.push("content-digest", "content-type");
      }
      const created = Math.floor(now() / 1000) * 1000;
      const result = await httpbis.signMessage(
        {
          name: "sig1",
          fields,
          params: ["keyid", "created", "expires"],
          paramValues: {
            keyid: "shopping-agent",
            created: new Date(created),
            expires: new Date(created + 300_000),
          },
          key: {
            id: "shopping-agent",
            sign: async (data) => sign("sha256", data, { key, dsaEncoding: "ieee-p1363" }),
          },
        },
        { method, url, headers: { ...headers, ...digest } as Record<string, string> }
      );
      return {
        ...digest,
        "Signature-Input": String(result.headers["Signature-Input"]),
        Signature: String(result.headers.Signature),
      };
    } catch {
      throw new UcpSigningError("signing_invalid_configuration");
    }
  };
}
export function signUcpRequest(request: SigningRequest) {
  return createUcpSigner(
    () => process.env.UCP_SIGNING_PRIVATE_KEY_BASE64,
    createPlatformProfile().keys[0]
  )(request);
}
