import { CheckoutError } from "./checkout-error";
import { HANDLER_NAME, HANDLER_VERSION, parseHashtrionHandler } from "./payment-adapter";
import type { PaymentHandler } from "./payment-credential";
import { fetchPublicJson, safePublicUrl } from "./safe-http";
import { authorityUrl } from "./ucp-profile";

// A supported adapter is code, not a merchant-supplied API execution instruction.
// IDs are local to the merchant and need not match the Platform's own handler ID.
export function parsePaymentHandler(raw: unknown, discovery = false): PaymentHandler | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return;
  }
  const entries = (raw as Record<string, unknown>)[HANDLER_NAME];
  if (!Array.isArray(entries) || entries.length !== 1) {
    return;
  }
  const handler = parseHashtrionHandler(entries[0]);
  if (discovery && (!handler?.schema || !handler.spec)) {
    return;
  }
  return handler;
}

export function assertPaymentHandlerConsistency(
  discovered: PaymentHandler | undefined,
  resolved: PaymentHandler | undefined
): void {
  if (
    discovered
      ? !resolved ||
        resolved.name !== discovered.name ||
        resolved.id !== discovered.id ||
        resolved.version !== discovered.version ||
        resolved.businessId !== discovered.businessId ||
        resolved.environment !== discovered.environment ||
        resolved.assets.some((asset) => !discovered.assets.includes(asset)) ||
        (resolved.schema !== undefined && resolved.schema !== discovered.schema) ||
        (resolved.spec !== undefined && resolved.spec !== discovered.spec)
      : resolved !== undefined
  ) {
    throw new CheckoutError("payment_handler_changed");
  }
}

function credentialUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error();
  }
  const url = safePublicUrl(value);
  // Preserve the adapter's operation boundary and reject normalization/query tricks.
  if (url.href !== value || url.search || url.pathname !== "/api/UcpPayment/issue-credential") {
    throw new Error();
  }
  return url.href;
}

export async function assertCredentialEndpointIdentity(
  handler: PaymentHandler,
  signal?: AbortSignal,
  fetch = fetchPublicJson
): Promise<void> {
  try {
    if (handler.name !== HANDLER_NAME || handler.version !== HANDLER_VERSION) {
      throw new Error();
    }
    const schema = authorityUrl(handler.schema, handler.name);
    const endpoint = credentialUrl(handler.credentialEndpoint);
    // Hashtrion's authorization document is a handler-specific contract, not a UCP
    // field. Derive its fixed path from the namespace-bound schema origin, never
    // from merchant config, the spec host, or the credential endpoint's origin.
    const metadataUrl = new URL(
      `/ucp/payment-handlers/${HANDLER_NAME}/credential-endpoints.json`,
      schema.origin
    ).href;
    // Unsigned GET only: no Agent ID, Checkout, signing headers or credentials.
    // No in-process authorization cache or fallback on a failed refresh.
    const fetched = await fetch(metadataUrl, signal);
    const metadata = fetched.body as Record<string, unknown> | null;
    if (
      fetched.url !== metadataUrl ||
      !metadata ||
      Array.isArray(metadata) ||
      metadata.version !== 1 ||
      metadata.handler !== handler.name ||
      metadata.handler_version !== handler.version
    ) {
      throw new Error();
    }
    const endpoints = metadata.credential_endpoints as Record<string, unknown> | null;
    if (!endpoints || typeof endpoints !== "object" || Array.isArray(endpoints)) {
      throw new Error();
    }
    for (const environment of ["sandbox", "production"]) {
      const values = endpoints[environment];
      if (
        !Array.isArray(values) ||
        values.length > 16 ||
        !values.every((value) => credentialUrl(value) === value)
      ) {
        throw new Error();
      }
    }
    if (
      !["sandbox", "production"].includes(handler.environment) ||
      !(endpoints[handler.environment] as string[]).includes(endpoint)
    ) {
      throw new Error();
    }
    // Exact URL authorization permits cross-origin APIs. Both metadata GET and
    // credential POST retain pinned public DNS, TLS verification and no redirects.
  } catch {
    throw new CheckoutError("credential_endpoint_untrusted");
  }
}
