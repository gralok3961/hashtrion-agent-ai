import { isDeepStrictEqual } from "node:util";
import { fetchPublicJson, safePublicUrl } from "./safe-http";

export const CATALOG_VERSION = "2026-08-25";
export const CATALOG_CAPABILITY = "dev.ucp.shopping.catalog.search";
export const SHOPPING_SERVICE = "dev.ucp.shopping";

/** Consumer declarations only; settlement remains unavailable until the credential adapter is connected. */
export function createPlatformProfile() {
  const publicKey = {
    kid: "shopping-agent",
    kty: "EC",
    crv: "P-256",
    x: "eNxUo9BEtpXQp3hUDmPKSmrlKmDkFUKmN_XA-xk72Q0",
    y: "N8yhxtYrTqcqhLxayizz0EHCZXnEgXOTPWSeARd6jCA",
    use: "sig",
    alg: "ES256",
  };
  return {
    signing_keys: [{ ...publicKey }],
    keys: [{ ...publicKey }],
    ucp: {
      version: CATALOG_VERSION,
      services: {
        [SHOPPING_SERVICE]: [
          {
            version: CATALOG_VERSION,
            spec: `https://ucp.dev/${CATALOG_VERSION}/specification/overview/`,
            transport: "rest",
            schema: `https://ucp.dev/${CATALOG_VERSION}/services/shopping/rest.openapi.json`,
          },
        ],
      },
      capabilities: {
        "dev.ucp.shopping.checkout": [
          {
            version: CATALOG_VERSION,
            spec: `https://ucp.dev/${CATALOG_VERSION}/specification/shopping/checkout/`,
            schema: `https://ucp.dev/${CATALOG_VERSION}/schemas/shopping/checkout.json`,
          },
        ],
        [CATALOG_CAPABILITY]: [
          {
            version: CATALOG_VERSION,
            spec: `https://ucp.dev/${CATALOG_VERSION}/specification/shopping/catalog/search/`,
            schema: `https://ucp.dev/${CATALOG_VERSION}/schemas/shopping/catalog_search.json`,
          },
        ],
      },
      payment_handlers: {
        "com.hashtrion.pay": [
          {
            id: "hashtrion_pay",
            available_instruments: [
              {
                type: "digital_asset",
                constraints: { properties: { network: { const: "xrpl" } } },
              },
            ],
            version: "2026-10-16",
            spec: "https://www.hashtrion.com/ucp/payment-handlers/com.hashtrion.pay",
            schema: "https://pay.hashtrion.com/ucp/payment-handlers/com.hashtrion.pay/schema.json",
          },
        ],
      },
    },
  };
}

export type PlatformProfileResult =
  | { ok: true; url: string }
  | {
      ok: false;
      reason:
        | "platform_profile_not_configured"
        | "platform_profile_invalid_url"
        | "platform_profile_is_merchant"
        | "platform_profile_unreachable"
        | "platform_profile_mismatch";
    };

/** Verify the deployed document, not merely a locally constructed identity. */
export async function verifyPlatformProfile(
  rawUrl: string | undefined,
  forbiddenOrigins: string[],
  signal: AbortSignal,
  fetchProfile: typeof fetchPublicJson = fetchPublicJson
): Promise<PlatformProfileResult> {
  if (!rawUrl) {
    return { ok: false, reason: "platform_profile_not_configured" };
  }
  let url: URL;
  try {
    url = safePublicUrl(rawUrl);
    if (url.pathname !== "/.well-known/ucp" || url.search) {
      throw new Error();
    }
  } catch {
    return { ok: false, reason: "platform_profile_invalid_url" };
  }
  if (forbiddenOrigins.includes(url.origin)) {
    return { ok: false, reason: "platform_profile_is_merchant" };
  }
  try {
    const fetched = await fetchProfile(url.href, signal);
    if (fetched.url !== url.href || !isDeepStrictEqual(fetched.body, createPlatformProfile())) {
      return { ok: false, reason: "platform_profile_mismatch" };
    }
    return { ok: true, url: url.href };
  } catch {
    return { ok: false, reason: "platform_profile_unreachable" };
  }
}
