// Local interoperability harness: generated keys exist only in this process. No environment secrets or network.
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { httpbis } from "http-message-signatures";
import { createInterface } from "node:readline";
import { createUcpSigner } from "../src/lib/server/ucp-signature";
async function main() {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicKey = {
    ...pair.publicKey.export({ format: "jwk" }),
    kid: "shopping-agent",
    use: "sig",
    alg: "ES256",
  };
  const pem = pair.privateKey.export({ format: "pem", type: "pkcs8" });
  const signer = createUcpSigner(() => Buffer.from(pem).toString("base64"), publicKey);
  for await (const line of createInterface({ input: process.stdin })) {
    const {
      method,
      path,
      body,
      profile = "https://agent.example/.well-known/ucp",
      idempotencyKey = randomUUID(),
      omitComponent,
      expired,
    } = JSON.parse(line);
    const url = new URL(path, "https://merchant.example");
    if (url.origin !== "https://merchant.example") {
      throw new Error("Test origin only");
    }
    const bytes = body === undefined ? undefined : Buffer.from(body, "utf8");
    const headers = {
      "UCP-Agent": `profile="${profile}"`,
      "Request-Id": randomUUID(),
      ...(method !== "GET" ? { "Idempotency-Key": idempotencyKey } : {}),
      ...(bytes ? { "Content-Type": "application/json" } : {}),
    };
    let signed = await signer({ url, method, body: bytes, headers, required: true });
    if (omitComponent || expired) {
      const fields = [
        "@method",
        "@authority",
        "@path",
        ...(url.search ? ["@query"] : []),
        "ucp-agent",
        "request-id",
        ...(method !== "GET" ? ["idempotency-key"] : []),
        ...(bytes ? ["content-digest", "content-type"] : []),
      ].filter((f) => f !== omitComponent);
      const time = Date.now() - (expired ? 600_000 : 0);
      const result = await httpbis.signMessage(
        {
          name: "sig1",
          fields,
          params: ["keyid", "created", "expires"],
          paramValues: {
            keyid: "shopping-agent",
            created: new Date(time),
            expires: new Date(time + 300_000),
          },
          key: {
            sign: async (data) =>
              sign("sha256", data, { key: pair.privateKey, dsaEncoding: "ieee-p1363" }),
          },
        },
        {
          method,
          url,
          headers: {
            ...headers,
            ...(signed["Content-Digest"] ? { "Content-Digest": signed["Content-Digest"] } : {}),
          } as Record<string, string>,
        }
      );
      signed = {
        ...signed,
        "Signature-Input": String(result.headers["Signature-Input"]),
        Signature: String(result.headers.Signature),
      };
    }
    console.log(
      JSON.stringify({
        method,
        path: url.pathname + url.search,
        body: body ?? "",
        headers: { ...headers, ...signed },
        publicKey,
      })
    );
  }
}
main().catch(() => {
  console.error("Test signing peer failed.");
  process.exitCode = 1;
});
