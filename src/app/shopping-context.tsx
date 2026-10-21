"use client";
import { isXrplTransactionHash, type ShoppingView, type ShoppingAction } from "@/lib/shopping";
import { checkoutRequirements, paymentFeedback } from "@/lib/payment-status";
import { formatMinorPrice } from "@/lib/catalog-display";
import { isCatalogImageUrl } from "@/lib/catalog-media";
import { maskAgentId } from "@/lib/agent-id";
import styles from "./checkout.module.css";

type Props = {
  value: ShoppingView;
  agentId: string;
  disabled: boolean;
  onAction: (action: ShoppingAction) => void;
  refreshing?: boolean;
  refreshError?: string;
  onAgentId?: () => void;
};
const merchantStatuses = {
  incomplete: "Buyer details needed",
  ready_for_complete: "Ready for payment",
  requires_escalation: "Merchant assistance needed",
  complete_in_progress: "Payment processing",
  completed: "Completed",
  canceled: "Canceled",
};

export default function ShoppingContext({
  value,
  agentId,
  disabled,
  onAction,
  refreshing = false,
  refreshError,
  onAgentId,
}: Props) {
  const c = value.checkout;
  if (!c && !value.selected && !value.notice) {
    return null;
  }
  const feedback = paymentFeedback(value);
  const attempt = value.paymentStatus ?? c?.paymentStatus;
  const completed = c?.status === "completed" && !!c.order;
  const txHash = c?.order?.blockchainTxHash;
  const blockchainUrl =
    completed && value.stage === "completed" && !c?.errors.length && isXrplTransactionHash(txHash)
      ? `https://test.bithomp.com/transaction/${txHash}`
      : undefined;
  const processing = c?.status === "complete_in_progress" || value.stage === "processing";
  const uncertain = value.stage === "uncertain";
  const lastMerchantStatus =
    !!attempt || uncertain || (processing && c?.status !== "complete_in_progress");
  const canceled = c?.status === "canceled";
  const blocked =
    !!c?.errors.length ||
    c?.status === "requires_escalation" ||
    ["failed", "unavailable"].includes(value.stage);
  const assetSelected =
    !!value.paymentAsset && !!value.availablePaymentAssets?.includes(value.paymentAsset);
  const checks = [
    {
      label: "Buyer email",
      complete: !!value.buyerEmailProvided,
      detail: value.buyerEmailProvided ? "Provided" : "Add your email in chat",
      state: value.buyerEmailProvided ? "Provided" : "Missing",
    },
    {
      label: "Payment asset",
      complete: assetSelected,
      detail: assetSelected
        ? `${value.paymentAsset} · Hashtrion Pay`
        : value.availablePaymentAssets?.length
          ? `Choose ${value.availablePaymentAssets.join(" or ")}`
          : "Check available assets",
      state: assetSelected ? "Selected" : "Missing",
    },
    {
      label: "Agent ID",
      complete: !!agentId,
      detail: agentId ? maskAgentId(agentId) : "Add your wallet’s Agent ID",
      state: agentId ? "Added" : "Missing",
    },
    {
      label: attempt
        ? "Checkout readiness"
        : lastMerchantStatus
          ? "Last merchant status"
          : "Merchant status",
      complete: c?.status === "ready_for_complete" && !c.errors.length,
      detail:
        c?.status === "ready_for_complete" && (attempt || lastMerchantStatus)
          ? "Details complete · no new payment authorized"
          : c
            ? merchantStatuses[c.status]
            : "Create a checkout first",
      state: lastMerchantStatus
        ? "Last checked"
        : processing
          ? "Processing"
          : c?.status === "ready_for_complete" && !c.errors.length
            ? "Ready"
            : "Needs review",
      tone: lastMerchantStatus ? "neutral" : processing ? "warning" : undefined,
    },
  ];
  const ready =
    !feedback &&
    !refreshing &&
    !refreshError &&
    !blocked &&
    !processing &&
    !uncertain &&
    !canceled &&
    !completed &&
    value.stage === "review" &&
    !!value.confirmation &&
    checks.every((check) => check.complete);
  const retryReady =
    !!value.canRetry &&
    !!value.confirmation &&
    !refreshing &&
    !refreshError &&
    !processing &&
    !uncertain &&
    !canceled &&
    !completed &&
    checks.every((check) => check.complete) &&
    c?.status === "ready_for_complete" &&
    !c.errors.length &&
    !value.retryUnavailableReason;
  const reviewable = !attempt && !!c && !completed && !processing && !uncertain && !canceled;
  const tone =
    feedback?.tone ??
    (completed || ready
      ? "success"
      : processing
        ? "warning"
        : uncertain || canceled || refreshing
          ? "neutral"
          : blocked
            ? "danger"
            : "warning");
  const badge =
    feedback?.badge ??
    (completed
      ? "Completed"
      : processing
        ? "Processing"
        : uncertain
          ? "Outcome unknown"
          : canceled
            ? "Canceled"
            : refreshing
              ? "Updating"
              : ready
                ? "Ready to purchase"
                : blocked
                  ? "Needs attention"
                  : "Needs action");
  const title =
    feedback?.title ??
    (canceled ? "Checkout canceled" : c ? "Review your checkout" : "Your selection");
  const missing = checks
    .filter((check) => !check.complete)
    .map((check) => check.label.toLowerCase());
  const guidance =
    feedback?.message ??
    (canceled
      ? "This checkout is closed."
      : refreshing
        ? "Refreshing checkout…"
        : refreshError ||
          value.notice ||
          checkoutRequirements(c) ||
          (ready
            ? "Review your order. Confirm Purchase authorizes one payment."
            : blocked
              ? "Resolve the checkout requirements to continue."
              : missing.length
                ? `Add ${missing.join(", ")} to continue.`
                : "Check status before confirming."));
  return (
    <section
      className={styles.card}
      aria-label="Current shopping context"
      aria-busy={refreshing}
      data-state={tone}
    >
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>CHECKOUT SUMMARY</p>
          <h3>{title}</h3>
          <p className={styles.merchant}>
            {c?.merchant ?? value.selected?.merchant ?? "Selected product"}
          </p>
        </div>
        <span
          className={`${styles.badge} ${ready ? styles.readyBadge : styles[tone]}`}
          data-loading={(processing && !completed) || undefined}
          role="status"
        >
          {badge}
        </span>
      </header>
      <p className={`${styles.banner} ${styles[tone]}`} role="status">
        {guidance}
      </p>
      {feedback &&
        value.notice &&
        value.notice !== feedback.message &&
        value.notice !== `${feedback.title}. See checkout below.` &&
        value.notice !== paymentFeedback({ ...value, canRetry: false })?.message &&
        (value.canRetry || value.retryUnavailableReason) && (
          <p className={styles.notice} role="status">
            {value.notice}
          </p>
        )}
      {c ? (
        <>
          <div className={styles.columns}>
            <section className={styles.section} aria-label="Order summary">
              <h4>
                <span aria-hidden="true">1</span> Order summary
              </h4>
              <ul className={styles.items}>
                {c.items.map((item) => {
                  const product = value.selected?.product;
                  const variant = product?.variants.find((v) => v.id === item.itemId);
                  const image = variant ? (variant.images[0] ?? product?.images[0]) : undefined;
                  const subtotal = item.amount * item.quantity;
                  return (
                    <li key={item.id}>
                      <div className={styles.itemTitle}>
                        {image && isCatalogImageUrl(image.url) && (
                          // eslint-disable-next-line @next/next/no-img-element -- Preserve the existing direct merchant image policy; no proxy.
                          <img
                            src={image.url}
                            alt={image.alt || item.title}
                            width="84"
                            height="112"
                            loading="lazy"
                            decoding="async"
                            referrerPolicy="no-referrer"
                          />
                        )}
                        <strong>{item.title}</strong>
                      </div>
                      <dl className={styles.itemAmounts}>
                        <div>
                          <dt>Quantity</dt>
                          <dd>{item.quantity}</dd>
                        </div>
                        <div>
                          <dt>Unit price</dt>
                          <dd>{formatMinorPrice(item.amount, c.currency)}</dd>
                        </div>
                        <div>
                          <dt>Line subtotal</dt>
                          <dd>
                            {Number.isSafeInteger(subtotal)
                              ? formatMinorPrice(subtotal, c.currency)
                              : "Unavailable"}
                          </dd>
                        </div>
                      </dl>
                    </li>
                  );
                })}
              </ul>
              <div className={styles.total}>
                <div>
                  <span>Order total</span>
                </div>
                <strong>{formatMinorPrice(c.total, c.currency)}</strong>
              </div>
              <p className={styles.paymentMethod}>
                {value.paymentAsset ? (
                  <>
                    {reviewable ? "Pay with" : "Payment asset:"}{" "}
                    <strong>{value.paymentAsset}</strong> via Hashtrion Pay
                  </>
                ) : (
                  "Select a payment asset for Hashtrion Pay"
                )}
              </p>
            </section>
            {!completed && !canceled && (
              <section className={styles.section} aria-label="Payment setup">
                <h4>
                  <span aria-hidden="true">2</span>{" "}
                  {reviewable ? "Payment setup" : "Payment details"}{" "}
                </h4>
                <ul className={styles.checklist}>
                  {checks.map((check) => {
                    const checkTone = check.tone ?? (check.complete ? "success" : "warning");
                    return (
                      <li key={check.label}>
                        <span
                          className={`${styles.checkIcon} ${styles[checkTone]}`}
                          aria-hidden="true"
                        >
                          {checkTone === "neutral"
                            ? "—"
                            : check.state === "Processing"
                              ? "…"
                              : check.complete
                                ? "✓"
                                : "!"}
                        </span>
                        <div>
                          <strong>{check.label}</strong>
                          <p>
                            {check.detail}
                            {check.tone === "neutral" && (
                              <span className={styles.lastChecked}> · Last checked</span>
                            )}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {onAgentId && reviewable && (
                  <button
                    type="button"
                    className={styles.textButton}
                    disabled={disabled}
                    onClick={onAgentId}
                  >
                    {agentId ? "Change Agent ID" : "Add Agent ID"}
                  </button>
                )}
              </section>
            )}
          </div>
          {completed && c.order && (
            <div className={styles.order}>
              <div>
                <span>Confirmed order</span>
                <strong>{c.order.id}</strong>
              </div>
              <div className={styles.orderActions}>
                <a
                  className={styles.primary}
                  href={c.order.permalinkUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                >
                  View order confirmation <span aria-hidden="true">↗</span>
                </a>
                {blockchainUrl && (
                  <a
                    className={styles.secondary}
                    href={blockchainUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    referrerPolicy="no-referrer"
                    title="View this transaction on XRPL Testnet"
                    aria-label="View on blockchain — XRPL Testnet"
                  >
                    View on blockchain <span aria-hidden="true">↗</span>
                  </a>
                )}
              </div>
            </div>
          )}
          {value.retryUnavailableReason && (
            <p className={styles.notice} role="status">
              {value.retryUnavailableReason}
            </p>
          )}
          <footer className={styles.actions}>
            {(value.canRetry || value.retryUnavailableReason) && (
              <button
                type="button"
                className={styles.primary}
                disabled={disabled || !retryReady}
                onClick={() => {
                  if (retryReady) {
                    onAction({ type: "retry", token: value.confirmation });
                  }
                }}
              >
                Try Again
              </button>
            )}
            {reviewable && (
              <button
                type="button"
                className={styles.primary}
                disabled={disabled || !ready}
                onClick={() => {
                  if (ready) {
                    onAction({ type: "confirm", token: value.confirmation });
                  }
                }}
              >
                Confirm Purchase
              </button>
            )}
            <button
              type="button"
              className={styles.secondary}
              disabled={disabled}
              onClick={() => onAction({ type: "status" })}
            >
              {refreshing ? "Refreshing…" : "Check status"}
            </button>
            {value.canCancel && reviewable && (
              <button
                type="button"
                className={styles.textButton}
                disabled={disabled}
                onClick={() => onAction({ type: "cancel" })}
              >
                Cancel checkout
              </button>
            )}
          </footer>
        </>
      ) : (
        value.selected && (
          <div className={styles.section}>
            <strong>{value.selected.product.title}</strong>
            <p>Quantity: {value.selected.quantity}</p>
            <p>
              {value.selected.variantId
                ? value.selected.product.variants.find((v) => v.id === value.selected!.variantId)
                    ?.title
                : "Choose a variant in the conversation."}
            </p>
          </div>
        )
      )}
      {value.notice &&
        value.notice !== guidance &&
        !feedback &&
        !completed &&
        !processing &&
        !uncertain && <p className={styles.notice}>{value.notice}</p>}
    </section>
  );
}
