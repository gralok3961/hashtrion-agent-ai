import type { PaymentStatus } from "../payment-status";
import { createHash, randomUUID } from "node:crypto";
import type { CatalogReport } from "../catalog-types";
import type { ShoppingView, CheckoutView } from "../shopping";
import type { CheckoutConnection } from "./checkout";
import { validCredential, type Credential } from "./payment";

export type ShoppingState = {
  catalog?: CatalogReport;
  selectionProvider?: CatalogReport["provider"];
  selected?: ShoppingView["selected"];
  checkout?: CheckoutView;
  connection?: CheckoutConnection;
  buyerEmail?: string;
  paymentAsset?: string;
  paymentCredential?: {
    credential: Credential;
    agentId: string;
    businessId: string;
    checkoutId: string;
    asset: string;
    fingerprint: string;
  };
  // Retain acquisition after token expiry so the same context cannot reissue.
  credentialAcquisition?: { fingerprint: string; agentHash: string };
  stage: ShoppingView["stage"];
  notice?: string;
  confirmation?: {
    token: string;
    fingerprint: string;
    agentHash: string;
    expires: number;
    retryAttempt?: string;
  };
  attempted?: string;
  // Direct Complete outcomes, bound to their dispatch ID; never reconstructed from GET.
  paymentAttempts?: {
    id: string;
    checkoutId: string;
    result: PaymentStatus;
    buyerFingerprint?: string;
    retryConsumed?: boolean;
  }[];
  uncertain?: boolean;
  paymentStatus?: PaymentStatus;
};
export function currentPaymentAttempt(s: ShoppingState) {
  const attempt = s.paymentAttempts?.at(-1);
  return attempt?.id === s.attempted && attempt?.checkoutId === s.checkout?.id
    ? attempt
    : undefined;
}
export function canRetrySpendingLimit(s: ShoppingState): boolean {
  const attempt = currentPaymentAttempt(s);
  return !!(
    attempt &&
    !attempt.retryConsumed &&
    attempt.buyerFingerprint === s.connection?.buyerFingerprint &&
    attempt.result.status === "rejected" &&
    attempt.result.code === "spending_limit_exceeded" &&
    s.paymentStatus?.status === "rejected" &&
    s.paymentStatus.code === "spending_limit_exceeded" &&
    !s.uncertain &&
    s.checkout?.status === "ready_for_complete" &&
    !s.checkout.order &&
    !s.checkout.errors.length &&
    Date.parse(s.checkout.expiresAt) > Date.now()
  );
}
function retryUnavailableReason(s: ShoppingState): string | undefined {
  const attempt = currentPaymentAttempt(s);
  if (
    attempt?.result.code !== "spending_limit_exceeded" ||
    attempt.result.status !== "rejected" ||
    s.checkout?.status === "completed"
  ) {
    return;
  }
  if (s.checkout?.status === "canceled") {
    return "This checkout is canceled. Try Again is unavailable.";
  }
  if (!(Date.parse(s.checkout!.expiresAt) > Date.now())) {
    return "This checkout has expired. Try Again is unavailable.";
  }
  if (s.checkout?.status !== "ready_for_complete" || s.checkout.errors.length) {
    return "The merchant checkout is no longer ready for payment. Use Check status to review its requirements.";
  }
  if (attempt.buyerFingerprint !== s.connection?.buyerFingerprint) {
    return "The merchant buyer information changed. Try Again is blocked to preserve the original buyer.";
  }
  if (attempt.retryConsumed || s.uncertain) {
    return "This retry could not be authorized safely. No further payment attempt is available. Use Check status.";
  }
  if (!s.confirmation?.retryAttempt) {
    return "Review the checkout, Agent ID and payment asset, then use Check status before trying again.";
  }
}
export function freshShoppingState(): ShoppingState {
  return { stage: "browsing" };
}
export function storePaymentCredential(
  s: ShoppingState,
  value: NonNullable<ShoppingState["paymentCredential"]>
) {
  // Explicit public projections remain the security boundary; exclude this property
  // from ordinary serialization as additional protection against accidental logging.
  Object.defineProperty(s, "paymentCredential", {
    value,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}
export const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function shoppingView(s: ShoppingState): ShoppingView {
  return {
    stage: s.stage,
    selected: s.selected,
    checkout: s.checkout,
    notice: s.notice,
    ...(s.paymentStatus ? { paymentStatus: s.paymentStatus } : {}),
    ...(s.checkout ? { buyerEmailProvided: !!s.buyerEmail } : {}),
    confirmation: s.confirmation?.token,
    ...(s.checkout
      ? {
          canRetry: canRetrySpendingLimit(s) && s.confirmation?.retryAttempt === s.attempted,
          retryUnavailableReason: retryUnavailableReason(s),
        }
      : {}),
    ...(s.checkout
      ? {
          canCancel:
            !s.uncertain &&
            !s.attempted &&
            ["incomplete", "ready_for_complete"].includes(s.checkout.status),
        }
      : {}),
    paymentAsset: s.paymentAsset,
    availablePaymentAssets: s.connection?.handler?.assets,
  };
}

// Single-instance, owner-bound server memory only; credentials are never persisted.
export function createShoppingStore(now = Date.now) {
  const entries = new Map<
    string,
    { owner: string; state: ShoppingState; expires: number; busy: boolean }
  >();
  return {
    reset(owner: string, id: string) {
      const entry = entries.get(id);
      if (!entry || entry.owner !== owner) {
        return;
      }
      if (entry.busy) {
        throw new Error("shopping_busy");
      }
      entries.delete(id);
    },
    acquire(owner: string, id?: string) {
      for (const [key, entry] of entries) {
        if (entry.expires < now() && !entry.busy) {
          entries.delete(key);
        }
      }
      if (id !== undefined && !/^[0-9a-f-]{36}$/.test(id)) {
        throw new Error("shopping_expired");
      }
      const key = id ?? randomUUID();
      let entry = entries.get(key);
      if (id && (!entry || entry.owner !== owner)) {
        throw new Error("shopping_expired");
      }
      if (!entry) {
        if (entries.size >= 256) {
          throw new Error("shopping_capacity");
        }
        entry = {
          owner,
          state: freshShoppingState(),
          expires: now() + 12 * 60 * 60_000,
          busy: false,
        };
        entries.set(key, entry);
      }
      if (entry.busy) {
        throw new Error("shopping_busy");
      }
      if (
        entry.state.paymentCredential &&
        !validCredential(entry.state.paymentCredential.credential, now())
      ) {
        delete entry.state.paymentCredential;
      }
      entry.busy = true;
      return {
        id: key,
        state: entry.state,
        release: () => {
          entry!.busy = false;
        },
      };
    },
  };
}
const globalState = globalThis as typeof globalThis & {
  __hashtrionShopping?: ReturnType<typeof createShoppingStore>;
};
export const shoppingStore = (globalState.__hashtrionShopping ??= createShoppingStore());
export function shoppingOwner(request: Request) {
  return fingerprint(request.headers.get("cookie") ?? "");
}
