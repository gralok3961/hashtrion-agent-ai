import { parsePaymentStatus } from "../payment-status";
import { createHash, randomUUID } from "node:crypto";
import { isXrplTransactionHash, type CheckoutView } from "../shopping";
import { parseUcpProfile } from "./ucp-profile";
import { fetchPublicJson, requestUcpJson, safePublicUrl, SafeFetchError } from "./safe-http";
import { CATALOG_VERSION, verifyPlatformProfile } from "./platform-profile";
import { assertPaymentHandlerConsistency, parsePaymentHandler } from "./payment-handler-discovery";
import type { PaymentHandler } from "./payment-credential";
import { CheckoutError } from "./checkout-error";

export const CHECKOUT_CAPABILITY = "dev.ucp.shopping.checkout";
export { CheckoutError } from "./checkout-error";
export type { PaymentHandler } from "./payment-credential";
export type CheckoutConnection = {
  domain: string;
  endpoint: string;
  platform: string;
  profileHandler?: PaymentHandler;
  handler?: PaymentHandler;
  buyerFingerprint?: string;
};
export type CheckoutOperation = "create" | "get" | "update" | "cancel" | "complete";
const obj = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new CheckoutError("invalid_checkout_response");
  }
  return v as Record<string, unknown>;
};
const str = (v: unknown, max = 300): string => {
  if (typeof v !== "string" || !v || v.length > max || /[\u0000-\u001f]/u.test(v)) {
    throw new CheckoutError("invalid_checkout_response");
  }
  return v;
};
const amount = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new CheckoutError("invalid_checkout_response");
  }
  return v;
};
const knownErrors = new Set([
  "payment_processing_unavailable",
  "payment_failed",
  "payment_instrument_invalid",
  "payment_credential_invalid",
  "invalid_checkout_state",
  "out_of_stock",
  "missing",
  "quantity_invalid",
  "idempotency_conflict",
  "buyer_email_required",
  "field_required",
  "invalid_line_item",
  "product_not_found",
  "capabilities_incompatible",
]);
export function checkoutErrors(body: unknown): string[] {
  const b = obj(body);
  // Transport errors use a top-level code; business errors use messages[].
  // Never forward arbitrary merchant content or diagnostics.
  const transport =
    b.code === undefined
      ? []
      : [knownErrors.has(b.code as string) ? (b.code as string) : "merchant_error"];
  if (b.messages === undefined) {
    return transport;
  }
  if (!Array.isArray(b.messages) || b.messages.length > 20) {
    throw new CheckoutError("invalid_checkout_response");
  }
  return [
    ...transport,
    ...b.messages
      .filter(
        (m) =>
          obj(m).type === "error" ||
          ["recoverable", "unrecoverable"].includes(String(obj(m).severity))
      )
      .map((m) =>
        knownErrors.has(obj(m).code as string) ? (obj(m).code as string) : "merchant_error"
      ),
  ];
}
export { parsePaymentHandler } from "./payment-handler-discovery";
export function applyCheckoutPaymentHandler(connection: CheckoutConnection, raw: unknown): void {
  const discovered = connection.profileHandler;
  const resolved = parsePaymentHandler(raw);
  assertPaymentHandlerConsistency(discovered, resolved);
  // Spec/schema identify the discovered adapter and can be omitted in UCP responses.
  // Runtime config is authoritative: never fall back to a profile credential endpoint.
  if (resolved && !resolved.credentialEndpoint) {
    throw new CheckoutError("payment_handler_changed");
  }
  connection.handler = resolved && {
    ...resolved,
    spec: discovered?.spec,
    schema: discovered?.schema,
  };
}
export function parseCheckout(raw: unknown, merchant: string, expectedId?: string): CheckoutView {
  const b = obj(raw),
    ucp = obj(b.ucp);
  if (ucp.status === "error") {
    throw new CheckoutError(checkoutErrors(b)[0] ?? "merchant_error");
  }
  const capability = obj(ucp.capabilities)[CHECKOUT_CAPABILITY];
  if (
    ucp.version !== CATALOG_VERSION ||
    ucp.status !== "success" ||
    !Array.isArray(capability) ||
    !capability.some((v) => obj(v).version === CATALOG_VERSION)
  ) {
    throw new CheckoutError(checkoutErrors(b)[0] ?? "invalid_checkout_response");
  }
  const id = str(b.id, 256),
    status = str(b.status);
  if (
    (expectedId && id !== expectedId) ||
    ![
      "incomplete",
      "ready_for_complete",
      "requires_escalation",
      "complete_in_progress",
      "completed",
      "canceled",
    ].includes(status)
  ) {
    throw new CheckoutError("invalid_checkout_response");
  }
  const currency = str(b.currency, 3);
  if (
    !/^[A-Z]{3}$/.test(currency) ||
    !Array.isArray(b.totals) ||
    b.totals.length > 30 ||
    !Array.isArray(b.line_items) ||
    !b.line_items.length ||
    b.line_items.length > 100
  ) {
    throw new CheckoutError("invalid_checkout_response");
  }
  const total = b.totals.filter((t) => obj(t).type === "total");
  if (total.length !== 1) {
    throw new CheckoutError("invalid_checkout_response");
  }
  const items = b.line_items.map((rawLine) => {
    const line = obj(rawLine),
      item = obj(line.item);
    const quantity = amount(line.quantity);
    if (!quantity || quantity > 100) {
      throw new CheckoutError("unsupported_quantity");
    }
    return {
      id: str(line.id, 256),
      itemId: str(item.id, 256),
      title: str(item.title),
      quantity,
      amount: amount(item.price),
    };
  });
  const expiresAt = str(b.expires_at, 64);
  if (!Number.isFinite(Date.parse(expiresAt))) {
    throw new CheckoutError("invalid_checkout_response");
  }
  const errors = checkoutErrors(b);
  if (status === "completed" && errors.length) {
    throw new CheckoutError(errors[0]);
  }
  let order: CheckoutView["order"];
  if (b.order !== undefined) {
    if (status !== "completed") {
      throw new CheckoutError("invalid_checkout_response");
    }
    const rawOrder = obj(b.order);
    const permalinkUrl = str(rawOrder.permalink_url, 2048);
    // Validate the returned HTTPS link, but never construct one or fetch it during payment.
    try {
      safePublicUrl(permalinkUrl);
    } catch {
      throw new CheckoutError("invalid_checkout_response");
    }
    order = {
      id: str(rawOrder.id, 256),
      permalinkUrl,
      ...(isXrplTransactionHash(rawOrder.blockchain_tx_hash)
        ? { blockchainTxHash: rawOrder.blockchain_tx_hash }
        : {}),
    };
  }
  if (status === "completed" && !order) {
    throw new CheckoutError("invalid_checkout_response");
  }
  const paymentStatus = ["completed", "complete_in_progress", "canceled"].includes(status)
    ? undefined
    : parsePaymentStatus(b.hashtrion_payment);
  return {
    ...(paymentStatus ? { paymentStatus } : {}),
    id,
    merchant,
    status: status as CheckoutView["status"],
    currency,
    total: amount(obj(total[0]).amount),
    expiresAt,
    items,
    errors,
    ...(order ? { order } : {}),
  };
}
export async function connectCheckout(
  domain: string,
  signal: AbortSignal,
  platformUrl = process.env.UCP_PLATFORM_PROFILE_URL
): Promise<CheckoutConnection> {
  const origin = safePublicUrl(`https://${domain}`);
  if (origin.hostname !== domain || origin.pathname !== "/" || origin.search) {
    throw new CheckoutError("unsupported_merchant");
  }
  const fetched = await fetchPublicJson(`${origin.origin}/.well-known/ucp`, signal);
  const profile = parseUcpProfile(fetched.body);
  const endpoints = profile.services.filter(
    (s) =>
      s.name === "dev.ucp.shopping" &&
      s.version === CATALOG_VERSION &&
      s.transport === "rest" &&
      s.endpoint
  );
  if (
    profile.version !== CATALOG_VERSION ||
    !profile.capabilities.some(
      (c) => c.name === CHECKOUT_CAPABILITY && c.version === CATALOG_VERSION
    ) ||
    endpoints.length !== 1
  ) {
    throw new CheckoutError("checkout_unsupported");
  }
  const endpoint = endpoints[0].endpoint!;
  const platform = await verifyPlatformProfile(
    platformUrl,
    [origin.origin, new URL(endpoint).origin],
    signal
  );
  if (!platform.ok) {
    throw new CheckoutError(platform.reason);
  }
  const handler = parsePaymentHandler(obj(obj(fetched.body).ucp).payment_handlers, true);
  return {
    domain,
    endpoint,
    platform: platform.url,
    profileHandler: handler && structuredClone(handler),
    handler,
  };
}
export async function checkoutRequest(
  connection: CheckoutConnection,
  operation: CheckoutOperation,
  id: string | undefined,
  body: unknown,
  key: string,
  signal: AbortSignal,
  request = requestUcpJson
): Promise<CheckoutView> {
  const base = safePublicUrl(connection.endpoint);
  if (base.search || (operation !== "create" && !id)) {
    throw new CheckoutError("invalid_checkout_request");
  }
  const suffix =
    operation === "create"
      ? ""
      : `/${encodeURIComponent(id!)}` +
        (["cancel", "complete"].includes(operation) ? `/${operation}` : "");
  const url = `${base.href.replace(/\/$/, "")}/checkout-sessions${suffix}`;
  const response = await request(
    url,
    operation === "get" ? "GET" : operation === "update" ? "PUT" : "POST",
    body,
    {
      "Request-Id": randomUUID(),
      "UCP-Agent": `profile="${connection.platform}"`,
      ...(operation !== "get" ? { "Idempotency-Key": key } : {}),
    },
    signal,
    operation === "complete" ? { timeoutPolicy: "complete_checkout" } : {}
  ).catch((error) => {
    if (
      error instanceof SafeFetchError &&
      (error.code === "signing_not_configured" || error.code === "signing_invalid_configuration")
    ) {
      throw new CheckoutError(error.code);
    }
    throw error;
  });
  if (operation === "complete") {
    const instruments = obj(obj(body).payment).instruments;
    const token = Array.isArray(instruments)
      ? obj(obj(instruments[0]).credential).token
      : undefined;
    if (typeof token === "string" && JSON.stringify(response.body).includes(token)) {
      throw new CheckoutError("credential_echo_blocked");
    }
  }
  const errors = checkoutErrors(response.body);
  if (response.status >= 400) {
    const b = obj(response.body);
    const ucp = b.ucp && typeof b.ucp === "object" ? (b.ucp as Record<string, unknown>) : undefined;
    const evidence =
      response.status === 503 &&
      b.code === "payment_processing_unavailable" &&
      ucp?.status === "error" &&
      ucp.version === CATALOG_VERSION
        ? parsePaymentStatus(b.hashtrion_payment)
        : undefined;
    throw new CheckoutError(errors[0] ?? "merchant_error", evidence);
  }
  const parsed = parseCheckout(response.body, connection.domain, id);
  if (operation === "create" || operation === "get" || operation === "update") {
    applyCheckoutPaymentHandler(connection, obj(obj(response.body).ucp).payment_handlers);
    // Keep buyer details server-side while binding approvals to the merchant's current buyer.
    const rawBuyer = obj(response.body).buyer;
    const buyer = rawBuyer == null ? {} : obj(rawBuyer);
    connection.buyerFingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          buyer.first_name ?? null,
          buyer.last_name ?? null,
          buyer.email ?? null,
          buyer.phone_number ?? null,
        ])
      )
      .digest("hex");
  }
  return parsed;
}
