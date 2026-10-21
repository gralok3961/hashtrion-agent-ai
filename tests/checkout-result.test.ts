import assert from "node:assert/strict";
import test from "node:test";
import { parseCheckout } from "../src/lib/server/checkout";
import { uncertainPaymentView, PAYMENT_OUTCOME_UNKNOWN_NOTICE, type ShoppingView } from "../src/lib/shopping";

const permalink = "https://orders.merchant.example/confirmation/order_1?view=receipt";
function response(status = "completed") {
  return { ucp: { version: "2026-08-25", status: "success", capabilities: {
    "dev.ucp.shopping.checkout": [{ version: "2026-08-25" }],
  } }, id: "checkout_1", status, currency: "USD", expires_at: "2099-01-01T00:00:00Z",
  totals: [{ type: "total", amount: 400 }], line_items: [{ id: "line_1", quantity: 1, item: { id: "item_1", title: "Report", price: 400 } }],
  ...(status === "completed" ? { order: { id: "order_1", permalink_url: permalink } } : {}) };
}

test("confirmed order preserves the exact merchant HTTPS permalink and projects only public order fields", () => {
  const raw = response();
  Object.assign(raw.order!, { paymentId: "private-payment-id", txHash: "private-hash", buyer: "private-buyer", credentials: "private-credentials" });
  const result = parseCheckout(raw, "merchant.example", "checkout_1");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.order, { id: "order_1", permalinkUrl: permalink });
  assert.ok(!JSON.stringify(result).includes("private-"));
});

test("confirmed order projects the stored blockchain hash only when it is exactly 64 hexadecimal characters", () => {
  for (const hash of ["A1".repeat(32), "b2".repeat(32)]) {
    const raw = response(); Object.assign(raw.order!, { blockchain_tx_hash: hash });
    const result = parseCheckout(raw, "merchant.example");
    assert.equal(result.order?.blockchainTxHash, hash);
    assert.equal(result.order?.permalinkUrl, permalink);
  }
  for (const hash of [undefined, null, "", "A".repeat(63), "A".repeat(65), "g".repeat(64),
    "A".repeat(64) + "\n", " " + "A".repeat(64), "https://example.com/transaction", 123, {}]) {
    const raw = response(); Object.assign(raw.order!, { blockchain_tx_hash: hash });
    const result = parseCheckout(raw, "merchant.example");
    assert.equal(result.status, "completed");
    assert.deepEqual(result.order, { id: "order_1", permalinkUrl: permalink });
  }
});

test("a completed checkout must include both an order ID and a safe permalink; no URL is fabricated", () => {
  for (const order of [undefined, null, {}, { id: "order_1" }, { permalink_url: permalink }, { id: "", permalink_url: permalink }]) {
    assert.throws(() => parseCheckout({ ...response(), order }, "merchant.example"), { code: "invalid_checkout_response" });
  }
  for (const url of ["", 123, "/orders/order_1", "http://merchant.example/orders/1", "javascript:alert(1)",
    "data:text/html,unsafe", "https://user:password@merchant.example/orders/1", "https://127.0.0.1/orders/1",
    "https://[::1]/orders/1", "https://10.0.0.1/orders/1", "https://169.254.169.254/orders/1",
    "https://168.63.129.16/orders/1", "https://merchant.internal/orders/1", "https://merchant.example:444/orders/1",
    "https://merchant.example/orders/1#secret", "https://merchant.example/ord ers/1", "x".repeat(2049)]) {
    assert.throws(() => parseCheckout({ ...response(), order: { id: "order_1", permalink_url: url } }, "merchant.example"), { code: "invalid_checkout_response" });
  }
});

test("only explicit UCP success can confirm an order, even with HTTP-success-shaped fields", () => {
  for (const status of [undefined, "error", "pending", "unknown", "SUCCESS", null]) {
    const body = response(); Object.assign(body.ucp, { status });
    assert.throws(() => parseCheckout(body, "merchant.example"));
  }
  for (const message of [{ type: "error" }, { severity: "recoverable" }, { severity: "unrecoverable" }]) {
    assert.throws(() => parseCheckout({ ...response(), messages: [{ ...message, code: "payment_failed", content: "private diagnostic" }] }, "merchant.example"), { code: "payment_failed" });
  }
});

test("pending and other non-completed statuses never expose an order", () => {
  assert.equal(parseCheckout(response("complete_in_progress"), "merchant.example").order, undefined);
  for (const status of ["incomplete", "ready_for_complete", "requires_escalation", "complete_in_progress", "canceled"]) {
    assert.throws(() => parseCheckout({ ...response(status), order: response().order }, "merchant.example"), { code: "invalid_checkout_response" });
  }
});

test("browser response loss preserves checkout context and permanently removes the stale confirmation from the view", () => {
  const previous: ShoppingView = { stage: "review", checkout: parseCheckout(response("ready_for_complete"), "merchant.example"),
    confirmation: "old-confirmation", canCancel: true, paymentAsset: "RLUSD", availablePaymentAssets: ["XRP", "RLUSD"] };
  const unknown = uncertainPaymentView(previous);
  assert.equal(unknown.stage, "uncertain");
  assert.equal(unknown.notice, PAYMENT_OUTCOME_UNKNOWN_NOTICE);
  assert.equal(unknown.checkout, previous.checkout);
  assert.equal(unknown.paymentAsset, previous.paymentAsset);
  assert.deepEqual(unknown.availablePaymentAssets, previous.availablePaymentAssets);
  assert.equal(unknown.confirmation, undefined); assert.equal(unknown.canCancel, false);
  assert.equal(previous.confirmation, "old-confirmation");
  assert.deepEqual(uncertainPaymentView(unknown), unknown);
});
