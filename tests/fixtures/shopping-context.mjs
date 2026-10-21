import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Only the CSS module is replaced. Render the actual production React component.
registerHooks({ load(url, context, next) {
  if (url.endsWith(".module.css")) return { format: "module", source: "export default {};", shortCircuit: true };
  return next(url, context);
} });
globalThis.fetch = async () => assert.fail("UI tests must never make network requests.");
const { default: ShoppingContext } = await import("../../src/app/shopping-context.tsx");
const { uncertainPaymentView } = await import("../../src/lib/shopping.ts");
const checkout = { id: "checkout_1", merchant: "merchant.example", status: "ready_for_complete", currency: "USD", total: 400,
  expiresAt: "2099-01-01T00:00:00Z", items: [{ id: "l1", itemId: "v1", title: "Report", quantity: 1, amount: 400 }], errors: [] };
const render = value => renderToStaticMarkup(createElement(ShoppingContext, { value, agentId: "", disabled: false, onAction: () => assert.fail("Rendering cannot submit an action") }));
const confirmed = render({ stage: "completed", checkout: { ...checkout, status: "completed", order: {
  id: "order_<confirmed>", permalinkUrl: "https://api.merchant.example/orders/order_1",
} } });
assert.match(confirmed, /Purchase completed/); assert.match(confirmed, /order_&lt;confirmed&gt;/);
assert.match(confirmed, /href="https:\/\/api.merchant.example\/orders\/order_1"/);
assert.match(confirmed, /View order confirmation/); assert.match(confirmed, /rel="noopener noreferrer"/);
assert.match(confirmed, /referrerPolicy="no-referrer"/);
assert.ok(!confirmed.includes("Confirm Purchase"));
assert.ok(!confirmed.includes("View on blockchain"));
const hash = "a1B2".repeat(16);
const completedCheckout = { ...checkout, status: "completed", order: {
  id: "order_1", permalinkUrl: "https://api.merchant.example/orders/order_1", blockchainTxHash: hash,
} };
const withExplorer = render({ stage: "completed", checkout: completedCheckout });
const explorer = withExplorer.match(/<a[^>]*href="https:\/\/test\.bithomp\.com\/transaction\/[^>]+>View on blockchain.*?<\/a>/)?.[0];
assert.ok(explorer); assert.ok(explorer.includes(`/transaction/${hash}"`));
assert.match(explorer, /target="_blank"/); assert.match(explorer, /rel="noopener noreferrer"/);
assert.match(explorer, /XRPL Testnet/); assert.match(explorer, /referrerPolicy="no-referrer"/);
assert.match(withExplorer, /View order confirmation/); assert.ok(!withExplorer.includes("Confirm Purchase"));
for (const invalid of [undefined, null, "", "0".repeat(63), "0".repeat(65), "g".repeat(64), hash + "\n", 42]) {
  const html = render({ stage: "completed", checkout: { ...completedCheckout, order: { ...completedCheckout.order, blockchainTxHash: invalid } } });
  assert.ok(!html.includes("test.bithomp.com")); assert.ok(!html.includes("View on blockchain"));
  assert.match(html, /View order confirmation/);
}
// Even a stale order in the browser cannot expose an explorer action in non-completed states.
for (const stage of ["browsing", "selected", "review", "processing", "uncertain", "canceled", "failed", "unavailable"]) {
  assert.ok(!render({ stage, checkout: completedCheckout }).includes("View on blockchain"));
}
for (const status of ["incomplete", "ready_for_complete", "requires_escalation", "complete_in_progress", "canceled"]) {
  assert.ok(!render({ stage: "completed", checkout: { ...completedCheckout, status } }).includes("View on blockchain"));
}
assert.ok(!render({ stage: "completed", checkout: { ...completedCheckout, order: undefined } }).includes("View on blockchain"));
const pending = render({ stage: "processing", checkout: { ...checkout, status: "complete_in_progress" } });
assert.match(pending, /Payment processing/); assert.match(pending, /Do not pay again while payment is pending/);
assert.ok(!pending.includes("Purchase completed")); assert.ok(!pending.includes("View order confirmation"));
assert.ok(!pending.includes("Confirm Purchase")); assert.match(pending, /Check status/);
const unknown = render(uncertainPaymentView({ stage: "review", checkout, confirmation: "stale", canCancel: true, paymentAsset: "RLUSD" }));
assert.match(unknown, /Payment outcome unknown/); assert.match(unknown, /Do not pay again/);
assert.match(unknown, /Checkout readiness/); assert.doesNotMatch(unknown, /Latest payment attempt/); assert.ok(!unknown.includes("Ready for payment")); assert.match(unknown, /Check status/);
assert.match(unknown, /Report/); assert.match(unknown, /RLUSD/);
assert.ok(!unknown.includes("Confirm Purchase")); assert.ok(!unknown.includes("Cancel checkout"));
assert.ok(!unknown.includes("View order confirmation")); assert.ok(!unknown.includes("Purchase completed"));


const connectedId = "agt_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const readyView = { stage: "review", checkout, confirmation: "approval", buyerEmailProvided: true,
  paymentAsset: "XRP", availablePaymentAssets: ["XRP", "RLUSD"], canCancel: true };
const renderSetup = (value, extra = {}) => renderToStaticMarkup(createElement(ShoppingContext, {
  value, agentId: connectedId, disabled: false, onAction: () => assert.fail("Rendering cannot submit"), ...extra,
}));
const ready = renderSetup(readyView);
assert.match(ready, /Ready to purchase/); assert.doesNotMatch(ready, /4 \/ 4 ready/);
assert.match(ready, /Buyer email/); assert.match(ready, /Provided/);
assert.match(ready, /Quantity/); assert.match(ready, /Unit price/); assert.match(ready, /Order total/);
assert.match(ready, /USD \$4\.00/); assert.match(ready, /XRP/);
assert.doesNotMatch(ready.match(/<button[^>]*>Confirm Purchase<\/button>/)[0], /disabled/);
assert.ok(!ready.includes(connectedId)); assert.match(ready, /Confirm Purchase authorizes one payment/);
for (const [view, extra, detail] of [
  [{ ...readyView, buyerEmailProvided: false }, {}, "Buyer email"],
  [{ ...readyView, paymentAsset: undefined }, {}, "Payment asset"],
  [readyView, { agentId: "" }, "Agent ID"],
  [{ ...readyView, checkout: { ...checkout, status: "incomplete" } }, {}, "Merchant status"],
  [{ ...readyView, confirmation: undefined }, {}, "Check status"],
]) {
  const html = renderSetup(view, extra);
  assert.match(html, /Needs action/); assert.ok(html.includes(detail));
  assert.match(html, /<button[^>]*disabled=""[^>]*>Confirm Purchase<\/button>/);
  assert.ok(!html.includes("Ready to purchase"));
}
const refreshing = renderSetup(readyView, { refreshing: true, disabled: true });
assert.match(refreshing, /Updating/); assert.match(refreshing, /Refreshing…/);
assert.match(refreshing, /<button[^>]*disabled=""[^>]*>Confirm Purchase<\/button>/);
const failedRefresh = renderSetup({ ...readyView, confirmation: undefined }, { refreshError: "Refresh unavailable. Use Check status." });
assert.match(failedRefresh, /Refresh unavailable/); assert.ok(!failedRefresh.includes("Ready to purchase"));
const blocked = renderSetup({ ...readyView, stage: "failed", checkout: { ...checkout, errors: ["merchant_error"] } });
assert.match(blocked, /Needs attention/); assert.match(blocked, /disabled=""[^>]*>Confirm Purchase/);
const submitting = renderSetup({ ...readyView, stage: "processing", confirmation: undefined });
assert.match(submitting, /Submitting payment/); assert.match(submitting, /Last merchant status/);
assert.match(submitting, /Last checked/); assert.ok(!submitting.includes("Confirm Purchase"));
console.log("Order, pending and uncertain shopping UI verified.");

const { paymentFeedback } = await import("../../src/lib/payment-status.ts");
for (const paymentStatus of [
  { status: "rejected", code: "spending_policy_unavailable" },
  { status: "rejected", code: "spending_limit_exceeded" },
  { status: "rejected", code: "agent_authorization_denied" },
  { status: "rejected", code: "signing_authority_unavailable" },
  { status: "not_sent", code: "payment_service_unavailable" },
  { status: "unknown" }, { status: "confirmed" },
]) {
  const value = { ...readyView, stage: "failed", paymentStatus, canCancel: false };
  const html = renderSetup(value);
  const expected = renderToStaticMarkup(createElement("p", null, paymentFeedback(value).message)).slice(3,-4);
  assert.ok(html.includes(expected), "UI uses the exact common payment explanation");
  assert.doesNotMatch(html, /Latest payment attempt/); assert.match(html, /Checkout readiness/);
  assert.ok(!html.includes("Ready for payment")); assert.ok(!html.includes("Ready to purchase"));
  assert.ok(!html.includes("Confirm Purchase")); assert.ok(!html.includes("View on blockchain"));
  assert.ok(!html.includes("Purchase completed")); assert.match(html, /Check status/);
}


const retryView = { ...readyView, stage: "failed", paymentStatus: { status: "rejected", code: "spending_limit_exceeded" }, canCancel: false, canRetry: true };
const retryHtml = renderSetup(retryView);
assert.match(retryHtml, /Spending limit exceeded/); assert.match(retryHtml, /Check status/);
assert.doesNotMatch(retryHtml.match(/<button[^>]*>Try Again<\/button>/)[0], /disabled/);
assert.ok(!retryHtml.includes(">Confirm Purchase</button>"));
for (const [value, extra] of [
  [retryView, { disabled: true }], [retryView, { refreshing: true }],
  [{ ...retryView, confirmation: undefined }, {}],
  [{ ...retryView, checkout: { ...checkout, expiresAt: "2000-01-01T00:00:00Z" }, retryUnavailableReason: "This checkout has expired. Try Again is unavailable." }, {}],
]) assert.match(renderSetup(value, extra), /<button[^>]*disabled=""[^>]*>Try Again<\/button>/);
assert.match(renderSetup({ ...retryView, canRetry: false, retryUnavailableReason: "This checkout has expired. Try Again is unavailable." }), /This checkout has expired/);
assert.ok(!renderSetup(uncertainPaymentView(retryView)).includes(">Try Again</button>"));
// Exercise the actual button handler, including its one-time confirmation token.
const actions = [];
const tree = ShoppingContext({ value: retryView, agentId: connectedId, disabled: false, onAction: action => actions.push(action) });
function findButton(node, label) {
  if (!node || typeof node !== "object") return;
  if (node.type === "button" && node.props.children === label) return node;
  for (const child of [node.props?.children].flat(Infinity)) { const found = findButton(child, label); if (found) return found; }
}
findButton(tree, "Try Again").props.onClick();
assert.deepEqual(actions, [{ type: "retry", token: retryView.confirmation }]);

assert.match(retryHtml, /Update it in your wallet, then try again/);
const ineligible = renderSetup({ ...retryView, canRetry: false });
assert.doesNotMatch(ineligible, /then try again|>Try Again<\/button>/);
assert.doesNotMatch(renderSetup({ ...retryView, notice: "Spending limit exceeded. See checkout below." }), /See checkout below/);
const readyActions = [];
const readyTree = ShoppingContext({ value: readyView, agentId: connectedId, disabled: false, onAction: action => readyActions.push(action) });
findButton(readyTree, "Confirm Purchase").props.onClick();
findButton(readyTree, "Check status").props.onClick();
assert.deepEqual(readyActions, [{ type: "confirm", token: readyView.confirmation }, { type: "status" }]);
