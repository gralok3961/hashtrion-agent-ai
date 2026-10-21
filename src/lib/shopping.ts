import { PAYMENT_OUTCOME_UNKNOWN_NOTICE, type PaymentStatus } from "./payment-status";
export { PAYMENT_OUTCOME_UNKNOWN_NOTICE } from "./payment-status";
import type { CatalogProduct } from "./catalog-types";

export function isPaymentAsset(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

export function isXrplTransactionHash(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 && /^[0-9a-f]{64}$/i.test(value);
}

export type CheckoutView = {
  id: string;
  merchant: string;
  status:
    | "incomplete"
    | "ready_for_complete"
    | "requires_escalation"
    | "complete_in_progress"
    | "completed"
    | "canceled";
  currency: string;
  total: number;
  expiresAt: string;
  paymentStatus?: PaymentStatus;
  items: { id: string; itemId: string; title: string; quantity: number; amount: number }[];
  order?: { id: string; permalinkUrl: string; blockchainTxHash?: string };
  errors: string[];
};
export type ShoppingView = {
  stage:
    | "browsing"
    | "selected"
    | "review"
    | "processing"
    | "uncertain"
    | "completed"
    | "canceled"
    | "failed"
    | "unavailable";
  selected?: { product: CatalogProduct; variantId?: string; quantity: number; merchant?: string };
  checkout?: CheckoutView;
  notice?: string;
  paymentStatus?: PaymentStatus;
  confirmation?: string;
  canCancel?: boolean;
  canRetry?: boolean;
  retryUnavailableReason?: string;
  paymentAsset?: string;
  availablePaymentAssets?: string[];
  buyerEmailProvided?: boolean;
};
export type ShoppingAction = { type: "confirm" | "cancel" | "status" | "retry"; token?: string };

// A lost browser response must not restore the old confirmation or discard the checkout context.
export function uncertainPaymentView(value: ShoppingView): ShoppingView {
  return {
    ...value,
    stage: "uncertain",
    paymentStatus: { status: "unknown" },
    notice: PAYMENT_OUTCOME_UNKNOWN_NOTICE,
    confirmation: undefined,
    canCancel: false,
    canRetry: false,
    retryUnavailableReason: undefined,
  };
}
