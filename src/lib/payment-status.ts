import type { CheckoutView } from "./shopping";

// Hashtrion display evidence, never an instruction to retry or a UCP checkout state.
export type PaymentStatus = {
  status: "rejected" | "not_sent" | "unknown" | "confirmed";
  code?: string;
};
const rejectionCodes = new Set([
  "spending_policy_unavailable",
  "spending_limit_exceeded",
  "spending_asset_denied",
  "agent_authorization_denied",
  "signing_authority_unavailable",
  "business_authorization_denied",
  "payment_method_unavailable",
  "payment_asset_unavailable",
  "payment_asset_invalid",
  "receiving_address_unavailable",
  "invalid_payment_request",
  "unsupported_network",
  "invalid_checkout_amount",
  "invalid_payment_credential",
]);
const serviceCodes = new Set([
  "signing_authority_invalid",
  "payment_pricing_unavailable",
  "payment_pricing_invalid",
  "checkout_currency_unavailable",
  "invalid_payment_amount",
  "invalid_asset_precision",
  "invalid_payment_precision",
]);
export function parsePaymentStatus(value: unknown): PaymentStatus | undefined {
  if (value === undefined) {
    return;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const { status, code } = value as Record<string, unknown>;
    if (status === "rejected" && typeof code === "string" && rejectionCodes.has(code)) {
      return { status, code };
    }
    if (status === "not_sent" && code === "payment_service_unavailable") {
      return { status, code };
    }
    if (status === "confirmed" && code === undefined) {
      return { status };
    }
    if (status === "unknown") {
      return { status, ...(typeof code === "string" && serviceCodes.has(code) ? { code } : {}) };
    }
  }
  // Unsupported evidence cannot turn an uncertain execution into a failed payment.
  return { status: "unknown" };
}

export const PAYMENT_OUTCOME_UNKNOWN_NOTICE =
  "Payment status is uncertain. Check status before taking further action. Do not pay again.";
const reasons: Record<string, [string, string]> = {
  spending_policy_unavailable: [
    "Spending policy unavailable",
    "Your spending policy is unavailable or expired. Update it in your wallet.",
  ],
  spending_limit_exceeded: ["Spending limit exceeded", "This payment exceeds your spending limit."],
  spending_asset_denied: [
    "Asset not authorized",
    "Your spending policy does not allow this asset. Review it in your wallet.",
  ],
  agent_authorization_denied: [
    "Agent account unavailable",
    "Check your Agent account and its connection in your wallet.",
  ],
  signing_authority_unavailable: [
    "Wallet authorization unavailable",
    "Check your Agent's payment authorization in your wallet.",
  ],
  invalid_payment_credential: [
    "Payment authorization invalid",
    "Authorization is invalid or expired. Check status and review your wallet.",
  ],
  business_authorization_denied: [
    "Merchant payment unavailable",
    "The merchant could not be authorized. Contact the merchant.",
  ],
  payment_method_unavailable: [
    "Merchant payment unavailable",
    "This payment method is unavailable. Contact the merchant.",
  ],
  payment_asset_unavailable: [
    "Payment asset unavailable",
    "The merchant cannot accept this asset. Check status.",
  ],
  payment_asset_invalid: [
    "Payment asset unavailable",
    "The merchant's asset configuration needs attention. Contact the merchant.",
  ],
  receiving_address_unavailable: [
    "Merchant payment unavailable",
    "The merchant cannot receive this payment. Contact the merchant.",
  ],
  invalid_payment_request: [
    "Payment request rejected",
    "The payment details were not accepted. Check status.",
  ],
  unsupported_network: [
    "Network not supported",
    "This payment network is not supported. Contact the merchant.",
  ],
  invalid_checkout_amount: [
    "Checkout amount rejected",
    "The checkout amount was not accepted. Check status.",
  ],
};
export function authorizationIssue(code: string): PaymentStatus | undefined {
  return [
    "credential_invalid",
    "credential_bad_request",
    "credential_unauthorized",
    "credential_forbidden",
    "credential_service_unavailable",
    "credential_request_failed",
  ].includes(code)
    ? { status: "not_sent", code }
    : undefined;
}
export type PaymentFeedback = {
  title: string;
  badge: string;
  tone: "success" | "warning" | "neutral" | "danger";
  message: string;
};
export function paymentFeedback(value: {
  checkout?: CheckoutView;
  stage: string;
  paymentStatus?: PaymentStatus;
  canRetry?: boolean;
}): PaymentFeedback | undefined {
  const c = value.checkout;
  if (c?.status === "completed" && c.order && !c.errors.length) {
    return {
      title: "Purchase completed",
      badge: "Completed",
      tone: "success",
      message: "Payment complete. Your order is confirmed.",
    };
  }
  if (c?.status === "canceled") {
    return;
  }
  if (c?.status === "complete_in_progress") {
    return {
      title: "Payment pending",
      badge: "Pending",
      tone: "warning",
      message: "Check status for updates. Do not pay again while payment is pending.",
    };
  }
  const result = value.paymentStatus ?? c?.paymentStatus;
  if (result?.status === "rejected" && result.code && reasons[result.code]) {
    const [title, reason] = reasons[result.code];
    const nextAction =
      result.code === "spending_limit_exceeded"
        ? value.canRetry
          ? " Update it in your wallet, then try again."
          : " Update it in your wallet. Check status."
        : "";
    return { title, badge: "Rejected", tone: "danger", message: reason + nextAction };
  }
  if (result?.status === "not_sent") {
    const authorization = authorizationIssue(result.code ?? "");
    const unavailable = !authorization || result.code === "credential_service_unavailable";
    const title = unavailable ? "Payment service unavailable" : "Authorization needs attention";
    const reason =
      result.code === "credential_forbidden"
        ? "Authorization was denied. Check your Agent account and wallet."
        : result.code === "credential_unauthorized"
          ? "Authorization service access is unavailable. Contact support."
          : result.code === "credential_invalid"
            ? "Authorization is invalid or expired. Check your wallet."
            : result.code === "credential_bad_request"
              ? "Check your Agent ID and checkout details."
              : result.code === "credential_request_failed"
                ? "Authorization could not be verified. Check status."
                : "The payment service is unavailable.";
    return {
      title,
      badge: unavailable ? "Unavailable" : "Needs attention",
      tone: "warning",
      message: `${reason} No payment request was sent${authorization ? " to the merchant" : " by the merchant"}.`,
    };
  }
  if (result?.status === "confirmed") {
    return {
      title: "Payment confirmed; order pending",
      badge: "Order pending",
      tone: "warning",
      message:
        "Payment confirmed; order still pending. Check status or contact the merchant. Do not pay again.",
    };
  }
  if (result?.status === "unknown" || value.stage === "uncertain") {
    const issue =
      result?.code === "payment_handler_changed"
        ? "Merchant payment settings changed. "
        : result?.code === "signing_authority_invalid"
          ? "Check your wallet authorization. "
          : result?.code && serviceCodes.has(result.code)
            ? "The payment service needs attention. "
            : "";
    return {
      title: "Payment outcome unknown",
      badge: "Outcome unknown",
      tone: "neutral",
      message: issue + PAYMENT_OUTCOME_UNKNOWN_NOTICE,
    };
  }
  if (value.stage === "processing") {
    return {
      title: "Submitting payment",
      badge: "Processing",
      tone: "warning",
      message: "Waiting for the payment result. Do not pay again.",
    };
  }
}

export function checkoutRequirements(c?: CheckoutView): string | undefined {
  if (!c) {
    return;
  }
  if (
    c.errors.includes("buyer_email_required") ||
    c.errors.includes("field_required") ||
    c.status === "incomplete"
  ) {
    return "Please provide your email to continue.";
  }
  if (c.errors.includes("out_of_stock")) {
    return "An item is out of stock. Check availability with the merchant.";
  }
  if (c.errors.includes("quantity_invalid")) {
    return "This quantity is unavailable. Update it before confirming.";
  }
  if (
    c.errors.includes("payment_instrument_invalid") ||
    c.errors.includes("payment_credential_invalid") ||
    c.errors.includes("payment_failed")
  ) {
    return "Payment details were not accepted. Check status; this does not confirm a failed payment.";
  }
  if (c.status === "requires_escalation") {
    return "This checkout needs merchant assistance.";
  }
  if (c.errors.length) {
    return "Resolve the checkout requirements before confirming.";
  }
}
