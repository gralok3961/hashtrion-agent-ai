import assert from "node:assert/strict";
import test from "node:test";
import { checkoutRequirements, parsePaymentStatus, paymentFeedback } from "../src/lib/payment-status";
import { checkoutRequest, parseCheckout } from "../src/lib/server/checkout";
import type { CheckoutView } from "../src/lib/shopping";

const checkout: CheckoutView = { id: "c1", merchant: "merchant.example", status: "ready_for_complete", currency: "USD", total: 400,
  expiresAt: "2099-01-01T00:00:00Z", items: [{ id: "l1", itemId: "v1", title: "Report", quantity: 1, amount: 400 }], errors: [] };
const connection = { domain: "merchant.example", endpoint: "https://merchant.example/ucp", platform: "https://agent.example/.well-known/ucp" };
const body = { payment: { instruments: [{ credential: { token: "synthetic-private-token" } }] } };
const error = (details: unknown) => ({ ucp: { version: "2026-08-25", status: "error" }, code: "payment_processing_unavailable",
  content: "synthetic-private-exception", hashtrion_payment: details });

test("Merchant error evidence is projected only from the expected UCP envelope, with no raw diagnostics", async () => {
  for (const code of ["spending_policy_unavailable", "spending_limit_exceeded", "agent_authorization_denied", "signing_authority_unavailable"]) {
    const details = { status: "rejected", code };
    await assert.rejects(checkoutRequest(connection, "complete", "c1", body, "key", new AbortController().signal,
      async () => ({ status: 503, url: connection.endpoint, body: error({ ...details, privateKey: "private-key", content: "private-error" }) })), (cause: unknown) => {
        assert.deepEqual((cause as { paymentStatus: unknown }).paymentStatus, details);
        assert.ok(!JSON.stringify(cause).includes("private")); return true;
      });
  }
  for (const status of [400, 401, 403, 409, 500, 502]) {
    await assert.rejects(checkoutRequest(connection, "complete", "c1", body, "key", new AbortController().signal,
      async () => ({ status, url: connection.endpoint, body: error({ status: "rejected", code: "spending_policy_unavailable" }) })), (cause: unknown) => {
        assert.equal((cause as { paymentStatus?: unknown }).paymentStatus, undefined); return true;
      });
  }
});

test("unsupported, malformed or claimed FAILED evidence stays unknown", () => {
  for (const value of [null, {}, [], "failed", { status: "failed", code: "payment_failed" },
    { status: "rejected", code: "internal_error" }, { status: "not_sent" }, { status: "confirmed", code: "payment_failed" }]) {
    assert.deepEqual(parsePaymentStatus(value), { status: "unknown" });
  }
  assert.equal(parsePaymentStatus(undefined), undefined, "old Merchant responses remain compatible");
  assert.deepEqual(parsePaymentStatus({ status: "unknown", code: "secret exception" }), { status: "unknown" });
});

test("readiness cannot contradict a rejected attempt; policy ambiguity and limit type are explained without invented amounts", () => {
  const policy = paymentFeedback({ stage: "failed", checkout, paymentStatus: { status: "rejected", code: "spending_policy_unavailable" } })!;
  assert.match(policy.message, /unavailable or expired/); assert.match(policy.message, /Update it in your wallet/);
  assert.equal(policy.badge, "Rejected"); assert.doesNotMatch(policy.message, /outcome is unknown|Ready for payment/);
  const limit = paymentFeedback({ stage: "failed", checkout, paymentStatus: { status: "rejected", code: "spending_limit_exceeded" } })!;
  assert.match(limit.message, /exceeds your spending limit/); assert.match(limit.message, /Check status/); assert.doesNotMatch(limit.message, /\$|[0-9]/);
});

test("checkout requirements, pending, unknown, service outage, payment receipt and completed order remain distinct", () => {
  assert.match(checkoutRequirements({ ...checkout, errors: ["field_required"] })!, /Please provide your email/);
  assert.match(checkoutRequirements({ ...checkout, status: "requires_escalation" })!, /merchant assistance/);
  assert.match(checkoutRequirements({ ...checkout, errors: ["payment_failed"] })!, /does not confirm a failed payment/);
  const pending = paymentFeedback({ stage: "processing", checkout: { ...checkout, status: "complete_in_progress" } })!;
  assert.equal(pending.badge, "Pending"); assert.match(pending.message, /Do not pay again while payment is pending/);
  const outage = paymentFeedback({ stage: "unavailable", checkout, paymentStatus: { status: "not_sent", code: "payment_service_unavailable" } })!;
  assert.equal(outage.title, "Payment service unavailable"); assert.match(outage.message, /No payment request was sent by the merchant/);
  const unknown = paymentFeedback({ stage: "uncertain", checkout, paymentStatus: { status: "unknown" } })!;
  assert.match(unknown.message, /Do not pay again/); assert.doesNotMatch(unknown.message, /payment failed|No payment.*sent/);
  const receipt = paymentFeedback({ stage: "uncertain", checkout, paymentStatus: { status: "confirmed" } })!;
  assert.equal(receipt.title, "Payment confirmed; order pending"); assert.match(receipt.message, /Do not pay again/);
  const completed = paymentFeedback({ stage: "completed", checkout: { ...checkout, status: "completed", order: { id: "ord_1", permalinkUrl: "https://merchant.example/orders/1" } }, paymentStatus: { status: "unknown" } })!;
  assert.equal(completed.title, "Purchase completed");
});

test("persisted Merchant attempt evidence is readable without exposing journal or account data", () => {
  const raw = { ucp: { version: "2026-08-25", status: "success", capabilities: { "dev.ucp.shopping.checkout": [{ version: "2026-08-25" }] } },
    id: "c1", status: "ready_for_complete", currency: "USD", expires_at: "2099-01-01T00:00:00Z", totals: [{ type: "total", amount: 400 }],
    line_items: [{ id: "l1", quantity: 1, item: { id: "v1", title: "Report", price: 400 } }],
    hashtrion_payment: { status: "rejected", code: "agent_authorization_denied", accountId: "private-account", credential: "private-credential" } };
  const view = parseCheckout(raw, "merchant.example");
  assert.deepEqual(view.paymentStatus, { status: "rejected", code: "agent_authorization_denied" });
  assert.ok(!JSON.stringify(view).includes("private"));
});


test("retry instructions use verified eligibility, never rejection text alone", () => {
  const value = { stage: "failed", checkout, paymentStatus: { status: "rejected" as const, code: "spending_limit_exceeded" } };
  assert.equal(paymentFeedback({ ...value, canRetry: true })!.message,
    "This payment exceeds your spending limit. Update it in your wallet, then try again.");
  for (const canRetry of [false, undefined]) {
    assert.doesNotMatch(paymentFeedback({ ...value, canRetry })!.message, /try again/i);
    assert.match(paymentFeedback({ ...value, canRetry })!.message, /Check status/);
  }
  for (const code of ["spending_policy_unavailable", "spending_asset_denied", "agent_authorization_denied", "signing_authority_unavailable"]) {
    const feedback = paymentFeedback({ ...value, paymentStatus: { status: "rejected", code } })!;
    assert.equal(feedback.badge, "Rejected");
    assert.doesNotMatch(feedback.message, /try again/i);
    assert.match(feedback.message, /wallet/);
  }
});
