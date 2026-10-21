import assert from "node:assert/strict";
import test from "node:test";
import { paymentFeedback } from "../src/lib/payment-status";
import type { ChatMessage } from "../src/lib/chat";
import type { CatalogReport } from "../src/lib/catalog-types";
import { executeShoppingTool, authorizeConfirmation } from "../src/lib/server/shopping-orchestrator";
import { runChat } from "../src/lib/server/chat-service";
import { freshShoppingState, createShoppingStore, fingerprint, storePaymentCredential, shoppingView } from "../src/lib/server/shopping-state";
import { CheckoutError, applyCheckoutPaymentHandler, parseCheckout, parsePaymentHandler, type CheckoutConnection, checkoutRequest } from "../src/lib/server/checkout";
import { type IssueCredential } from "../src/lib/server/payment";
import type { ModelResponse, ResponseParameters } from "../src/lib/server/discovery";
import type { ShoppingAction } from "../src/lib/shopping";

const signal = new AbortController().signal;
const agentId = `agt_${"A".repeat(26)}`;
const connection: CheckoutConnection = { domain: "merchant.example", endpoint: "https://api.merchant.example/ucp", platform: "https://agent.example/.well-known/ucp", handler: { name: "com.hashtrion.pay", id: "hashtrion_pay", version: "2026-10-16", businessId: "biz_fixture", environment: "sandbox", assets: ["XRP", "RLUSD"] } };
connection.profileHandler = structuredClone(connection.handler);
function handlerRegistry(assets: string[] = ["XRP", "RLUSD"]) {
  return { "com.hashtrion.pay": [{ id: "hashtrion_pay", version: "2026-10-16", config: { business_id: "biz_fixture", environment: "sandbox", credential_endpoint: "https://pay.hashtrion.com/api/UcpPayment/issue-credential" }, available_instruments: [{ type: "digital_asset", constraints: { properties: { network: { const: "xrpl" }, asset: { enum: assets } } } }] }] };
}
const catalog: CatalogReport = { status: "completed", merchantDomain: "merchant.example", query: "reports", messages: [], diagnostics: { profileUrl: "https://merchant.example/.well-known/ucp" }, products: [
  { id: "one", title: "First report", images: [], variants: [{ id: "v1", title: "PDF", images: [], price: { amount: 900, currency: "USD" } }] },
  { id: "two", title: "RLUSD report", images: [], variants: [{ id: "v2", title: "PDF", images: [], price: { amount: 400, currency: "USD" } }] },
] };
const text = (output_text = "Here is the current result."): ModelResponse => ({ status: "completed", output_text, output: [] });
const call = (name: string, args: object = {}): ModelResponse => ({ status: "completed", output_text: "", output: [{ type: "function_call", name, arguments: JSON.stringify(args), call_id: `call_${name}` }] });
const select = (index = 2) => call("select_product", { index, variant_id: null, quantity: 1 });
function checkoutBody(status = "ready_for_complete", quantity = 1, id = "c1") {
  return { ucp: { version: "2026-08-25", status: "success", capabilities: { "dev.ucp.shopping.checkout": [{ version: "2026-08-25" }] } }, id, status, currency: "USD", expires_at: "2099-01-01T00:00:00Z", line_items: [{ id: "l1", item: { id: "v2", title: "RLUSD report", price: 400 }, quantity }], totals: [{ type: "total", amount: quantity * 400 }], ...(status === "completed" ? { order: { id: "order_1", permalink_url: "https://api.merchant.example/orders/order_1" } } : {}) };
}
function fixture(searchCatalog = catalog, merchantAssets = ["XRP", "RLUSD"], state = freshShoppingState()) {
  const discoveredConnection = structuredClone(connection);
  discoveredConnection.profileHandler!.assets = [...merchantAssets];
  discoveredConnection.handler!.assets = [...merchantAssets];
  const history: ChatMessage[] = [];
  const modelCalls: ResponseParameters[] = [];
  const operations: { op: string; body: unknown; key: string; id?: string }[] = [];
  const issued: Parameters<IssueCredential>[0][] = [];
  let queue: ModelResponse[] = [], remote = checkoutBody();
  let issuer: IssueCredential = async () => { throw new CheckoutError("credential_endpoint_untrusted"); };
  let createError: string | undefined;
  const events: string[] = [];
  let complete: () => Promise<ReturnType<typeof checkoutBody>> = async () => ({ ...remote, status: "completed", order: { id: "order_1", permalink_url: "https://api.merchant.example/orders/order_1" } });
  let handlers = handlerRegistry(merchantAssets);
  let updateHandlers: ReturnType<typeof handlerRegistry> | undefined;
  const request: typeof checkoutRequest = async (_connection, op, id, body, key) => {
    operations.push({ op, body, key, id });
    events.push(op);
    if (op === "create" && createError) throw new CheckoutError(createError);
    if (op === "create" || op === "update") remote = checkoutBody("ready_for_complete", (body as { line_items: { quantity: number }[] }).line_items[0].quantity);
    if (op === "cancel") remote = checkoutBody("canceled");
    if (op === "complete") remote = await complete();
    if (op === "update" && updateHandlers) { handlers = updateHandlers; updateHandlers = undefined; }
    const result = parseCheckout(remote, "merchant.example", id);
    if (["create", "get", "update"].includes(op)) applyCheckoutPaymentHandler(_connection, handlers);
    return result;
  };
  return { state, history, modelCalls, operations, issued, events,
    setComplete: (value: () => Promise<ReturnType<typeof checkoutBody>>) => { complete = value; },
    setHandlerId: (id: string) => { discoveredConnection.profileHandler!.id = id; discoveredConnection.handler!.id = id; handlers["com.hashtrion.pay"][0].id = id; },
    setHandlers: (value: ReturnType<typeof handlerRegistry>) => { handlers = value; },
    setUpdateHandlers: (value: ReturnType<typeof handlerRegistry>) => { updateHandlers = value; },
    failCreate: (code: string) => { createError = code; },
    setRemote: (v: ReturnType<typeof checkoutBody> & { hashtrion_payment?: unknown }) => { remote = v; },
    setIssuer: (value: IssueCredential) => { issuer = value; },
    enableIssuer: () => { issuer = async context => { issued.push(context); return { type: "hashtrion_authorization", token: "synthetic-unit-test-credential", expiry: "2099-01-01T00:00:00Z" }; }; },
    async turn(content: string, outputs: ModelResponse[] = [], action?: ShoppingAction, identity: string | undefined = agentId, confirmation?: string) {
      queue = [...outputs];
      history.push({ role: "user", content });
      const reply = await runChat(history, { model: "fixture-model", signal, discoveryEnabled: true, agentId: identity, provider: null,
        responses: { create: async params => { modelCalls.push(structuredClone(params)); assert.ok(queue.length, "Unexpected model call"); return queue.shift()!; } },
        verify: async () => [{ status: "verified", domain: "merchant.example", profileUrl: "https://merchant.example/.well-known/ucp", profile: { version: "2026-08-25", services: [], capabilities: [], restEndpoints: [] } }],
        catalog: async () => structuredClone(searchCatalog),
        shopping: { state, action, confirmation, connect: async () => structuredClone(discoveredConnection), request, issue: async context => { events.push("issue"); return issuer(context); } },
      });
      assert.equal(queue.length, 0, "Expected all planned model steps");
      history.push(reply);
      assert.ok(!JSON.stringify(reply).includes("synthetic-unit-test-credential"));
      assert.ok(!JSON.stringify(reply).includes(agentId));
      return reply;
    },
    async search() {
      return this.turn("Show reports from merchant.example", [call("search_catalog", { mode: "search", query: "reports", merchant_domain: "merchant.example", merchant_name: null }), text('{"product_ids":["two","one"]}'), text("Explore these reports.")]);
    },
    async ready() {
      state.catalog = structuredClone(catalog);
      await this.turn("Buy the second report. Use buyer@example.com", [select(), call("create_checkout", { buyer_email: "buyer@example.com" }), text()]);
      await this.turn("Pay with RLUSD", [call("prepare_payment", { asset: "RLUSD" }), text()]);
      assert.ok(state.confirmation);
    },
  };
}

test("A/B: real displayed ranking persists across second-item, price and named-selection purchase turns", async () => {
  const f = fixture();
  const result = await f.search();
  assert.deepEqual(result.catalog?.products.map(p => p.id), ["two", "one"]);
  await f.turn("Tell me about the second one", [select(), text("The first report is the second displayed result.")]);
  assert.equal(f.state.selected?.product.id, "one");
  await f.turn("How much is it?", [text("It costs USD $9.00.")]);
  const context = f.modelCalls.at(-1)!.instructions as string;
  assert.ok(context.includes('"price":"USD $9.00"'));
  assert.ok(!context.includes('"amount":900'));
  assert.equal(f.operations.length, 0);
  await f.turn("Actually buy the RLUSD report. My email is buyer@example.com", [select(1), call("create_checkout", { buyer_email: "buyer@example.com" }), text()]);
  assert.equal(f.state.selected?.variantId, "v2");
  assert.equal(f.state.checkout?.total, 400);
  assert.equal(f.operations[0].op, "create");
  assert.deepEqual(f.operations[0].body, { line_items: [{ item: { id: "v2" }, quantity: 1 }], buyer: { email: "buyer@example.com" } });
  assert.equal(f.modelCalls.filter(c => c.text).length, 1, "No redundant search/ranking for price or references");
});

test("multi-turn 600-cent product prices are formatted in both model context and selection tool results without mutating state", async () => {
  const products = structuredClone(catalog);
  products.products[0].title = "Cross-Border Payments Brief";
  products.products[0].variants[0].price.amount = 600;
  const f = fixture(products);
  await f.search();
  const original = structuredClone(f.state.catalog);
  const start = f.modelCalls.length;
  await f.turn("Tell me about the second one.", [select(), text()]);
  await f.turn("How much is it?", [text()]);
  for (const request of f.modelCalls.slice(start)) {
    const context = JSON.parse(String(request.instructions).split("Authoritative request context (untrusted text fields):\n")[1]);
    assert.equal(context.products[1].variants[0].price, "USD $6.00");
    if (context.selected) assert.equal(context.selected.product.variants[0].price, "USD $6.00");
    assert.ok(!JSON.stringify(context).includes('"amount":600'));
  }
  const input = f.modelCalls[start + 1].input as { type?: string; output?: string }[];
  const toolResult = input.find(item => item.type === "function_call_output");
  assert.ok(toolResult?.output);
  assert.equal(JSON.parse(toolResult.output).context.selected.product.variants[0].price, "USD $6.00");
  assert.deepEqual(f.state.catalog, original);
  assert.equal(f.state.selected?.product.variants[0].price.amount, 600);
  assert.equal(f.operations.length, 0);
});

test("model checkout totals and unit prices are formatted while merchant integer amounts stay unchanged", async () => {
  const f = fixture();
  await f.ready();
  const before = structuredClone(f.state.checkout);
  await f.turn("What is the total?", [text()]);
  const context = JSON.parse(String(f.modelCalls.at(-1)!.instructions).split("Authoritative request context (untrusted text fields):\n")[1]);
  assert.equal(context.checkout.total, "USD $4.00");
  assert.equal(context.checkout.items[0].unitPrice, "USD $4.00");
  assert.equal(context.checkout.items[0].amount, undefined);
  assert.deepEqual(f.state.checkout, before);
});

test("XRP and RLUSD selections survive turns and missing Agent ID prompts never re-request the asset", async () => {
  for (const asset of ["XRP", "RLUSD"] as const) {
    const f = fixture();
    f.state.catalog = structuredClone(catalog);
    await f.turn("Buy the second report", [select(), call("create_checkout", { buyer_email: null }), text()], undefined, "");
    const reply = await f.turn(`I want to pay with ${asset.toLowerCase()}`, [call("prepare_payment", { asset }), text("Which payment asset?")], undefined, "");
    assert.equal(f.state.paymentAsset, asset);
    assert.equal(reply.shopping?.paymentAsset, asset);
    assert.ok(reply.content.includes(`Pay with ${asset}`));
    assert.match(reply.content, /Add your Agent ID/);
    assert.doesNotMatch(reply.content, /choose|which payment asset|tell me which/i);
    assert.equal(reply.shopping?.confirmation, undefined);
    const later = await f.turn("Check status", [], { type: "status" }, "");
    assert.equal(later.shopping?.paymentAsset, asset);
    assert.match(later.content, /Add your Agent ID/);
    const provided = await f.turn("I added my Agent ID", [], { type: "status" });
    assert.equal(provided.shopping?.paymentAsset, asset);
    assert.ok(provided.shopping?.confirmation);
    assert.match(provided.content, /Confirm Purchase/);
    assert.doesNotMatch(provided.content, /Add your Agent ID|choose a payment asset/i);
    assert.equal(f.issued.length, 0);
    assert.ok(f.operations.every(op => op.op !== "complete"));
    const context = JSON.parse(String(f.modelCalls.at(-1)!.instructions).split("Authoritative request context (untrusted text fields):\n")[1]);
    assert.equal(context.paymentAsset, asset);
    assert.equal(context.hasAgentId, false);
  }
});

test("asset preference before checkout survives product selection and still requires explicit payment confirmation", async () => {
  const f = fixture();
  const selected = await f.turn("I want to pay with RLUSD", [call("prepare_payment", { asset: "RLUSD" }), text()], undefined, "");
  assert.equal(selected.shopping?.paymentAsset, "RLUSD");
  assert.match(selected.content, /Add your Agent ID/);
  assert.equal(f.operations.length, 0);
  f.state.catalog = structuredClone(catalog);
  await f.turn("Buy the second report", [select(), call("create_checkout", { buyer_email: null }), text()], undefined, "");
  assert.equal(f.state.paymentAsset, "RLUSD");
  assert.equal(f.state.confirmation, undefined);
  const reply = await f.turn("Use XRP instead", [call("prepare_payment", { asset: "XRP" }), text()], undefined, "");
  assert.equal(reply.shopping?.paymentAsset, "XRP");
  assert.equal(f.issued.length, 0);
  assert.ok(f.operations.every(op => op.op !== "complete"));
});

test("unsupported or model-invented assets do not overwrite a valid selection", async () => {
  const f = fixture(); await f.ready();
  f.state.connection = { ...connection, handler: { ...connection.handler!, assets: ["RLUSD"] } };
  await f.turn("Pay with XRP", [call("prepare_payment", { asset: "XRP" })]);
  assert.equal(f.state.paymentAsset, "RLUSD");
  assert.match(f.state.notice!, /does not support/);
  await f.turn("Tell me about XRPish", [call("prepare_payment", { asset: "XRP" })]);
  assert.equal(f.state.paymentAsset, "RLUSD");
  assert.equal(f.issued.length, 0);
});

test("C/D: quantity change uses full writable fields, invalidates old approval and cancel uses current checkout", async () => {
  const f = fixture(); await f.ready(); const old = f.state.confirmation!.token;
  await f.turn("Can I buy two instead?", [call("update_checkout", { quantity: 2, buyer_email: null }), text()]);
  assert.equal(f.state.checkout?.total, 800);
  assert.equal(f.state.selected?.quantity, 2);
  assert.notEqual(f.state.confirmation!.token, old);
  const update = f.operations.find(o => o.op === "update")!;
  assert.deepEqual(update.body, { line_items: [{ id: "l1", item: { id: "v2" }, quantity: 2 }], buyer: { email: "buyer@example.com" } });
  await f.turn("Confirm", [], { type: "confirm", token: old });
  assert.equal(f.issued.length, 0);
  assert.equal(f.operations.filter(o => o.op === "complete").length, 0);
  await f.turn("Cancel it", [call("cancel_checkout"), text()]);
  assert.equal(f.state.checkout?.status, "canceled");
});

test("E/F: explicit approval privately issues and completes in the same operation with the merchant instrument", async () => {
  for (const asset of ["XRP", "RLUSD"]) {
    const f = fixture(); f.setHandlerId(`merchant_${asset}_payment`); await f.ready(); f.enableIssuer();
    if (asset === "XRP") await f.turn("Use XRP", [call("prepare_payment", { asset }), text()]);
    const token = f.state.confirmation!.token, modelCount = f.modelCalls.length;
    f.setComplete(async () => {
      assert.equal(f.state.paymentCredential?.credential.token, "synthetic-unit-test-credential");
      assert.equal(f.state.paymentCredential?.agentId, agentId);
      assert.equal(f.state.paymentCredential?.businessId, "biz_fixture");
      assert.equal(f.state.paymentCredential?.checkoutId, "c1");
      assert.equal(f.state.paymentCredential?.asset, asset);
      assert.ok(f.state.attempted);
      assert.equal(f.state.uncertain, true);
      assert.ok(!JSON.stringify(f.state).includes("synthetic-unit-test-credential"));
      return checkoutBody("completed");
    });
    const result = await f.turn("Confirm the purchase", [], { type: "confirm", token });
    assert.match(result.content, /Purchase completed. Order order_1/);
    assert.equal(f.state.stage, "completed");
    assert.equal(f.state.checkout?.status, "completed");
    assert.equal(f.state.confirmation, undefined);
    assert.equal(f.state.uncertain, false);
    assert.equal(f.state.paymentCredential, undefined, "release private credential after terminal result");
    assert.equal(f.issued.length, 1);
    assert.equal(f.issued[0].agentId, agentId);
    assert.equal(f.issued[0].checkout.total, 400);
    assert.equal(f.issued[0].asset, asset);
    const submission = f.operations.find(o => o.op === "complete")!;
    assert.equal(submission.key, f.state.attempted);
    assert.equal(submission.key, f.issued[0].idempotencyKey);
    assert.deepEqual(submission.body, { payment: { instruments: [{ id: submission.key, type: "digital_asset", handler_id: `merchant_${asset}_payment`, network: "xrpl", asset, selected: true,
      credential: { type: "hashtrion_authorization", token: "synthetic-unit-test-credential", expiry: "2099-01-01T00:00:00Z" } }] } });
    assert.deepEqual(f.events.slice(-3), ["get", "issue", "complete"]);
    assert.equal(f.modelCalls.length, modelCount);
    await f.turn("What is the status?", [call("get_checkout"), text()]);
    assert.ok(!JSON.stringify(f.state).includes(agentId));
    assert.ok(!JSON.stringify(f.modelCalls).includes("synthetic-unit-test-credential"));
    assert.ok(!JSON.stringify(f.modelCalls).includes(agentId));
    await f.turn("Confirm again", [], { type: "confirm", token });
    assert.equal(f.issued.length, 1);
    assert.equal(f.operations.filter(o => o.op === "complete").length, 1);
    assert.equal(f.state.attempted, submission.key);
  }
});

test("only Confirm Purchase triggers issuance; asset, Agent ID, updates, payment questions and text approval cannot", async () => {
  const f = fixture(); f.enableIssuer(); await f.ready();
  assert.equal(f.issued.length, 0);
  await f.turn("I connected my Agent Account", [text()]);
  await f.turn("Make it two", [call("update_checkout", { quantity: 2, buyer_email: null }), text()]);
  await f.turn("How does payment work?", [text()]);
  await f.turn("Go ahead", [call("complete_checkout")], undefined, agentId, f.state.confirmation!.token);
  assert.equal(f.issued.length, 0, "even text plus a real confirmation token is not a button action");
  assert.ok(f.operations.every(o => o.op !== "complete"));
  const modelCount = f.modelCalls.length;
  await f.turn("Confirm", [], { type: "confirm", token: f.state.confirmation!.token });
  assert.equal(f.issued.length, 1);
  assert.deepEqual(f.events.slice(-3), ["get", "issue", "complete"], "one confirmed operation runs preflight, issuance and completion");
  assert.equal(f.modelCalls.length, modelCount, "the confirmed operation has no model round-trip");
  assert.equal(f.state.confirmation, undefined);
});

test("cancellation before Confirm Purchase never acquires a credential", async () => {
  const f = fixture(); f.enableIssuer(); await f.ready();
  const token = f.state.confirmation!.token;
  await f.turn("Cancel", [], { type: "cancel" });
  assert.equal(f.state.checkout?.status, "canceled");
  await f.turn("Old click", [], { type: "confirm", token });
  assert.equal(f.issued.length, 0);
  assert.equal(f.state.paymentCredential, undefined);
  assert.ok(f.operations.every(o => o.op !== "complete"));
});

test("the existing conversation lock prevents concurrent issuance and a repeated successful click never resubmits", async () => {
  const store = createShoppingStore();
  const entry = store.acquire("owner");
  const f = fixture(catalog, ["XRP", "RLUSD"], entry.state);
  await f.ready(); entry.release();
  let begin!: () => void, finish!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { begin = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  f.setIssuer(async () => {
    calls++;
    assert.equal(f.state.confirmation, undefined, "the click is consumed before network operations");
    begin(); await pending;
    return { type: "hashtrion_authorization", token: "synthetic-unit-test-credential", expiry: "2099-01-01T00:00:00Z" };
  });
  const token = f.state.confirmation!.token;
  const locked = store.acquire("owner", entry.id);
  const first = f.turn("Confirm", [], { type: "confirm", token }).finally(locked.release);
  await started;
  try { assert.throws(() => store.acquire("owner", entry.id), /shopping_busy/); }
  finally { finish(); }
  await first;
  const again = store.acquire("owner", entry.id);
  try { await f.turn("Duplicate click", [], { type: "confirm", token }); }
  finally { again.release(); }
  assert.equal(calls, 1);
  assert.equal(f.state.confirmation, undefined);
  assert.equal(f.operations.filter(o => o.op === "complete").length, 1);
});

test("an uncertain attempt cannot reacquire or resubmit after credential expiry", async () => {
  const f = fixture(); f.enableIssuer(); await f.ready();
  f.setComplete(async () => { throw new Error("timeout"); });
  const token = f.state.confirmation!.token;
  await f.turn("Confirm", [], { type: "confirm", token });
  const key = f.state.attempted;
  f.state.paymentCredential!.credential.expiry = "2000-01-01T00:00:00Z";
  const result = await f.turn("Status", [], { type: "status" });
  assert.match(result.content, /Payment outcome unknown/);
  assert.equal(result.shopping?.confirmation, undefined);
  assert.equal(f.state.paymentCredential, undefined);
  assert.equal(f.state.uncertain, true);
  await f.turn("Old click", [], { type: "confirm", token });
  assert.equal(f.issued.length, 1);
  assert.equal(f.operations.filter(o => o.op === "complete").length, 1);
  assert.equal(f.state.attempted, key);
});

test("a rejected changed handler revokes an acquired credential without allowing another payment", async () => {
  const f = fixture(); f.enableIssuer(); await f.ready();
  f.setComplete(async () => { throw new Error("timeout"); });
  await f.turn("Confirm", [], { type: "confirm", token: f.state.confirmation!.token });
  const changed = handlerRegistry();
  changed["com.hashtrion.pay"][0].config.business_id = "biz_different";
  f.setHandlers(changed);
  const result = await f.turn("Status", [], { type: "status" });
  assert.match(paymentFeedback(result.shopping!)!.message, /Merchant payment settings changed/);
  assert.equal(f.state.paymentCredential, undefined);
  assert.equal(f.state.credentialAcquisition, undefined);
  assert.equal(f.state.confirmation, undefined);
  assert.equal(f.state.uncertain, true);
  assert.ok(f.state.attempted);
  assert.equal(f.issued.length, 1);
  assert.equal(f.operations.filter(o => o.op === "complete").length, 1);
});

test("private credential bindings expire on identity or checkout changes without clearing the attempt", async () => {
  for (const change of ["agent", "checkout"]) {
    const f = fixture(); await f.ready(); f.enableIssuer();
    f.setComplete(async () => { throw new Error("timeout"); });
    await f.turn("Confirm", [], { type: "confirm", token: f.state.confirmation!.token });
    assert.ok(f.state.paymentCredential);
    const key = f.state.attempted;
    if (change === "agent") await f.turn("Status", [], { type: "status" }, `agt_${"B".repeat(26)}`);
    else {
      f.setRemote(checkoutBody("ready_for_complete", 2));
      await f.turn("Status", [], { type: "status" });
    }
    assert.equal(f.state.paymentCredential, undefined);
    assert.equal(f.issued.length, 1);
    assert.equal(f.state.attempted, key);
    assert.equal(f.state.uncertain, true);
    assert.equal(f.operations.filter(o => o.op === "complete").length, 1);
  }
});

test("invalid issuer result never enters conversation state or model/browser output", async () => {
  const f = fixture(); await f.ready();
  f.setIssuer(async () => ({ type: "hashtrion_authorization", token: "synthetic-unit-test-credential", expiry: "2000-01-01T00:00:00Z" }));
  const result = await f.turn("Confirm", [], { type: "confirm", token: f.state.confirmation!.token });
  assert.match(paymentFeedback(result.shopping!)!.message, /invalid or expired/);
  assert.equal(f.state.paymentCredential, undefined);
  assert.ok(f.operations.every(o => o.op !== "complete"));
});

test("G: credential rejection is safe and stale confirmation cannot repeat issuance", async () => {
  const f = fixture(); await f.ready();
  let calls = 0;
  f.setIssuer(async () => { calls++; throw new CheckoutError("credential_forbidden"); });
  const token = f.state.confirmation!.token;
  const result = await f.turn("Go ahead", [], { type: "confirm", token });
  assert.match(paymentFeedback(result.shopping!)!.message, /Authorization was denied/);
  assert.match(paymentFeedback(result.shopping!)!.message, /No payment request was sent to the merchant/);
  assert.equal(f.state.stage, "failed");
  await f.turn("Go ahead again", [], { type: "confirm", token });
  assert.equal(calls, 1);
  assert.equal(f.state.paymentCredential, undefined);
  assert.equal(f.operations.filter(o => o.op === "complete").length, 0);
});

test("unapproved endpoint blocks acquisition after confirmation and never calls complete", async () => {
  const f = fixture(); await f.ready();
  const result = await f.turn("Confirm", [], { type: "confirm", token: f.state.confirmation!.token });
  assert.match(result.content, /endpoint could not be trusted/);
  assert.equal(f.state.stage, "failed");
  assert.equal(f.operations.filter(o => o.op === "complete").length, 0);
});

test("model-generated complete and forged confirmation never issue a credential", async () => {
  const f = fixture(); await f.ready(); f.enableIssuer();
  await f.turn("What would payment do?", [call("complete_checkout")]);
  assert.equal(f.issued.length, 0);
  await f.turn("Confirm", [], { type: "confirm", token: "forged" });
  assert.equal(f.issued.length, 0);
  await f.turn("Confirm", [], { type: "confirm", token: f.state.confirmation!.token }, `agt_${"B".repeat(26)}`);
  assert.equal(f.issued.length, 0);
});

test("remote price change requires another displayed summary and confirmation", async () => {
  const f = fixture(); await f.ready(); f.enableIssuer();
  f.setRemote(checkoutBody("ready_for_complete", 2));
  const result = await f.turn("Confirm", [], { type: "confirm", token: f.state.confirmation!.token });
  assert.match(result.content, /changed/);
  assert.equal(f.state.checkout?.total, 800);
  assert.equal(f.issued.length, 0);
});

test("ambiguous variants, invented IDs and model-invented buyer email fail closed", async () => {
  const f = fixture(); f.state.catalog = structuredClone(catalog);
  f.state.catalog.products[1].variants.push({ ...catalog.products[1].variants[0], id: "v3" });
  await f.turn("Buy the second one", [select(), call("create_checkout", { buyer_email: null })]);
  assert.equal(f.operations.length, 0);
  assert.equal(f.state.selected?.variantId, undefined);
  await f.turn("Choose an unknown variant", [call("select_product", { index: 2, variant_id: "invented", quantity: 1 })]);
  assert.equal(f.operations.length, 0);
  await f.turn("Choose PDF", [call("select_product", { index: 2, variant_id: "v2", quantity: 1 }), call("create_checkout", { buyer_email: "invented@example.com" })]);
  assert.equal(f.operations.length, 0);
});

test("H: conversation ownership, concurrency, expiry, and new-chat state reset", () => {
  let now = 0; const store = createShoppingStore(() => now), owner = fingerprint("test-session");
  const first = store.acquire(owner); first.state.catalog = structuredClone(catalog);
  assert.throws(() => store.acquire(owner, first.id), /busy/);
  first.release();
  assert.throws(() => store.acquire("other-session", first.id), /expired/);
  const again = store.acquire(owner, first.id); assert.equal(again.state.catalog?.products.length, 2); again.release();
  const next = store.acquire(owner); assert.deepEqual(next.state, { stage: "browsing" }); next.release();
  assert.equal(again.state.paymentCredential, undefined, "No credential identity before issuance");
  store.reset(owner, first.id);
  assert.throws(() => store.acquire(owner, first.id), /expired/);
  now = 13 * 60 * 60_000;
  assert.throws(() => store.acquire(owner, next.id), /expired/);
});

test("private credentials survive only within the owned server conversation and expire on access", () => {
  let now = Date.parse("2026-10-13T00:00:00Z");
  const store = createShoppingStore(() => now);
  const entry = store.acquire("owner");
  storePaymentCredential(entry.state, { credential: { type: "hashtrion_authorization", token: "synthetic-private-token", expiry: "2026-10-13T00:05:00Z" }, agentId, businessId: "biz_fixture", checkoutId: "c1", asset: "RLUSD", fingerprint: "fixture" });
  entry.release();
  assert.throws(() => store.acquire("other", entry.id), /expired/);
  const own = store.acquire("owner", entry.id);
  assert.equal(own.state.paymentCredential?.credential.token, "synthetic-private-token");
  assert.ok(!JSON.stringify(own.state).includes("synthetic-private-token"));
  assert.ok(!JSON.stringify(shoppingView(own.state)).includes("synthetic-private-token"));
  own.release();
  const separate = store.acquire("owner");
  assert.equal(separate.state.paymentCredential, undefined);
  separate.release();
  now += 300_000;
  const expired = store.acquire("owner", entry.id);
  assert.equal(expired.state.paymentCredential, undefined);
  expired.release();
  store.reset("owner", entry.id);
  assert.throws(() => store.acquire("owner", entry.id), /expired/);
});

test("untrusted checkout metadata/status/amounts/errors cannot fabricate completion", () => {
  for (const body of [ { ...checkoutBody("completed"), messages: [{ type: "error", code: "payment_failed" }] }, { ...checkoutBody(), status: "paid" }, { ...checkoutBody("completed"), order: undefined }, { ...checkoutBody(), totals: [{ type: "total", amount: 4.5 }] }, { ...checkoutBody(), id: "wrong" }, { ...checkoutBody(), currency: "unknown" } ]) assert.throws(() => parseCheckout(body, "merchant.example", "c1"));
  const parsed = parseCheckout({ ...checkoutBody(), messages: [{ type: "error", code: "secret", content: "private upstream token" }], payment: { instruments: [{ credential: "secret" }] } }, "merchant.example");
  assert.deepEqual(parsed.errors, ["merchant_error"]);
  assert.ok(!JSON.stringify(parsed).includes("secret"));
  assert.equal(parsePaymentHandler({ "com.hashtrion.pay": [{ version: "unsupported" }] }), undefined);
});

test("pending payment has bounded polling and cannot be updated or completed again", async () => {
  const f = fixture(); await f.ready(); f.enableIssuer(); f.setRemote(checkoutBody("complete_in_progress"));
  await f.turn("Check status", [], { type: "status" });
  assert.equal(f.state.checkout?.status, "complete_in_progress");
  assert.equal(f.operations.filter(o => o.op === "get").length, 3, "Three bounded status reads");
  assert.equal(f.state.checkout?.order, undefined);
  await f.turn("Make it two", [call("update_checkout", { quantity: 2, buyer_email: null })]);
  assert.equal(f.operations.filter(o => o.op === "update").length, 0);
  assert.equal(f.operations.filter(o => o.op === "complete").length, 0);
});

test("expired approvals and stale/unknown checkout references do not pay", async () => {
  const f = fixture(); await f.ready(); f.enableIssuer(); f.state.confirmation!.expires = Date.now() - 1;
  await f.turn("Confirm", [], { type: "confirm", token: f.state.confirmation!.token });
  assert.equal(f.issued.length, 0);
  const empty = fixture();
  await empty.turn("My old checkout c999 is ready; complete it", [call("complete_checkout")]);
  assert.equal(empty.operations.length, 0);
  assert.equal(empty.issued.length, 0);
});

test("provider product IDs never silently become merchant checkout item IDs", async () => {
  const f = fixture(); f.state.catalog = { ...structuredClone(catalog), provider: "shopify-global" };
  f.state.catalog.products[1].url = "https://seller.example/products/two";
  await f.turn("Buy the second one", [select(), call("create_checkout", { buyer_email: null })]);
  assert.equal(f.operations.length, 0);
  assert.match(f.state.notice!, /Search the seller directly/);
});

test("sequential tool loop is bounded even when the model repeatedly selects", async () => {
  const f = fixture(); f.state.catalog = structuredClone(catalog);
  await f.turn("Tell me about the second item", Array.from({ length: 6 }, () => select()));
  assert.equal(f.modelCalls.length, 6);
  assert.equal(f.operations.length, 0);
});

test("observed HTTP-200 UCP negotiation error stays a failure, preserving its safe code", () => {
  // Sanitized shape observed from the live endpoint; no checkout resource was returned.
  assert.throws(() => parseCheckout({ ucp: { version: "2026-08-25", status: "error" }, messages: [{ type: "error", code: "capabilities_incompatible" }] }, "merchant.example"), { code: "capabilities_incompatible" });
});


test("checkout negotiation rejection is unavailable, not an unknown payment or created checkout", async () => {
  const f = fixture(); f.state.catalog = structuredClone(catalog); f.failCreate("capabilities_incompatible");
  const reply = await f.turn("Buy the second report", [select(), call("create_checkout", { buyer_email: null })]);
  assert.match(reply.content, /could not negotiate checkout/);
  assert.equal(f.state.stage, "unavailable");
  assert.equal(f.state.checkout, undefined);
  assert.equal(f.state.uncertain, false);
  assert.equal(f.issued.length, 0);
  assert.deepEqual(f.operations.map(o => o.op), ["create"]);
});


test("checkout-specific RLUSD handler and verified identity survive create, update, status and conversational turns", async () => {
  const f = fixture();
  f.setHandlers(handlerRegistry(["RLUSD"]));
  await f.ready();
  const id = f.state.checkout!.id;
  assert.deepEqual(f.state.connection!.profileHandler!.assets, ["XRP", "RLUSD"]);
  assert.deepEqual(f.state.connection!.handler!.assets, ["RLUSD"]);
  await f.turn("Make it two", [call("update_checkout", { quantity: 2, buyer_email: null }), text()]);
  await f.turn("Check my checkout", [], { type: "status" });
  await f.turn("What can I pay with?", [text()]);
  assert.equal(f.state.checkout!.id, id);
  assert.equal(f.state.checkout!.total, 800);
  assert.equal(f.state.connection!.handler!.businessId, "biz_fixture");
  assert.equal(f.state.paymentAsset, "RLUSD");
  assert.deepEqual(f.state.connection!.handler!.assets, ["RLUSD"]);
  const context = JSON.parse(String(f.modelCalls.at(-1)!.instructions).split("Authoritative request context (untrusted text fields):\n")[1]);
  assert.deepEqual(context.availablePaymentAssets, ["RLUSD"]);
  assert.equal(context.paymentAsset, "RLUSD");
  assert.equal(context.connection, undefined);
  assert.ok(f.state.confirmation);
  assert.equal(f.issued.length, 0);
  assert.ok(f.operations.every(o => o.op !== "complete"));
});

test("new checkout restrictions preserve preference but revoke approval until a supported asset is explicitly selected", async () => {
  const f = fixture(); await f.ready();
  await f.turn("Use XRP", [call("prepare_payment", { asset: "XRP" }), text()]);
  const approval = f.state.confirmation!.token;
  f.setUpdateHandlers(handlerRegistry(["RLUSD"]));
  const reply = await f.turn("Update quantity", [call("update_checkout", { quantity: 2, buyer_email: null }), text()]);
  assert.equal(f.state.paymentAsset, "XRP");
  assert.equal(f.state.confirmation, undefined);
  assert.match(reply.content, /Available assets: RLUSD/);
  await f.turn("Confirm", [], { type: "confirm", token: approval });
  assert.equal(f.issued.length, 0);
  await f.turn("Use RLUSD", [call("prepare_payment", { asset: "RLUSD" }), text()]);
  assert.equal(f.state.paymentAsset, "RLUSD");
  assert.ok(f.state.confirmation);
  assert.ok(f.operations.every(o => o.op !== "complete"));
});

test("a changed handler during confirmation refresh cannot issue credentials or preserve stale approval", async () => {
  const f = fixture(); await f.ready();
  const approval = f.state.confirmation!.token;
  const changed = handlerRegistry(); changed["com.hashtrion.pay"][0].config.business_id = "biz_attacker";
  f.setHandlers(changed);
  const reply = await f.turn("Confirm", [], { type: "confirm", token: approval });
  assert.match(reply.content, /payment configuration changed/);
  assert.equal(f.state.connection!.handler!.businessId, "biz_fixture");
  assert.equal(f.state.checkout!.id, "c1");
  assert.equal(f.state.confirmation, undefined);
  assert.equal(f.issued.length, 0);
  assert.ok(f.operations.every(o => o.op !== "complete"));
});

test("valid restriction changes during final refresh require renewed purchase confirmation", async () => {
  const f = fixture(); await f.ready();
  const approval = f.state.confirmation!.token;
  f.setHandlers(handlerRegistry(["RLUSD"]));
  const reply = await f.turn("Confirm", [], { type: "confirm", token: approval });
  assert.match(reply.content, /Checkout changed/);
  assert.deepEqual(f.state.connection!.handler!.assets, ["RLUSD"]);
  assert.notEqual(f.state.confirmation?.token, approval);
  assert.equal(f.issued.length, 0);
  assert.ok(f.operations.every(o => o.op !== "complete"));
});

test("a runtime credential endpoint change during final refresh invalidates the consumed confirmation before issuance", async () => {
  const f = fixture(); await f.ready(); f.enableIssuer();
  const approval = f.state.confirmation!.token;
  const changed = handlerRegistry();
  changed["com.hashtrion.pay"][0].config.credential_endpoint = "https://other.example/api/UcpPayment/issue-credential";
  f.setHandlers(changed);
  const reply = await f.turn("Confirm", [], { type: "confirm", token: approval });
  assert.match(reply.content, /Checkout changed/);
  assert.notEqual(f.state.confirmation?.token, approval);
  assert.equal(f.issued.length, 0);
  assert.equal(f.state.paymentCredential, undefined);
  assert.ok(f.operations.every(o => o.op !== "complete"));
});


test("merchant-provided asset names flow unchanged through selection, context and existing credential boundary", async () => {
  for (const asset of ["EURC", "USD.C+1"]) {
    const f = fixture(catalog, [asset, "OTHER"]);
    f.setHandlers(handlerRegistry([asset]));
    f.state.catalog = structuredClone(catalog);
    const created = await f.turn("Buy the second report", [select(), call("create_checkout", { buyer_email: null }), text()]);
    assert.deepEqual(created.shopping?.availablePaymentAssets, [asset]);
    assert.ok(created.content.includes(`Choose a payment asset: ${asset}`));
    await f.turn(`I want to pay with ${asset}`, [call("prepare_payment", { asset }), text()]);
    await f.turn(`${asset}로 결제할게요`, [call("prepare_payment", { asset }), text()]);
    await f.turn("Check status", [], { type: "status" });
    assert.equal(f.state.paymentAsset, asset);
    assert.deepEqual(f.state.connection!.handler!.assets, [asset]);
    const context = JSON.parse(String(f.modelCalls.at(-1)!.instructions).split("Authoritative request context (untrusted text fields):\n")[1]);
    assert.deepEqual(context.availablePaymentAssets, [asset]);
    f.enableIssuer();
    await f.turn("Confirm", [], { type: "confirm", token: f.state.confirmation!.token });
    assert.equal(f.issued.length, 1);
    assert.equal(f.issued[0].asset, asset);
    const body = f.operations.find(o => o.op === "complete")!.body as { payment: { instruments: { asset: string }[] } };
    assert.equal(body.payment.instruments[0].asset, asset);
    assert.equal(f.state.checkout?.status, "completed");
  }
});

test("dynamic asset selection rejects unadvertised choices and regex-like model inventions", async () => {
  const f = fixture(catalog, ["EURC", "USD.C+1"]);
  f.state.catalog = structuredClone(catalog);
  await f.turn("Buy the second report", [select(), call("create_checkout", { buyer_email: null }), text()]);
  await f.turn("Use EURC", [call("prepare_payment", { asset: "EURC" }), text()]);
  for (const [message, asset] of [["Pay with BTC", "BTC"], ["Pay with anything", ".*"], ["Use USDxC11", "USD.C+1"], ["EURCish", "EURC"], ["Use EURC", "EURC\n"]]) {
    await f.turn(message, [call("prepare_payment", { asset })]);
    assert.equal(f.state.paymentAsset, "EURC");
    assert.equal(f.issued.length, 0);
  }
});

test("an unverified asset preference never invents checkout availability", async () => {
  const f = fixture();
  const reply = await f.turn("Use EURC", [call("prepare_payment", { asset: "EURC" }), text()], undefined, "");
  assert.equal(reply.shopping?.paymentAsset, "EURC");
  assert.equal(reply.shopping?.availablePaymentAssets, undefined);
  assert.equal(reply.shopping?.confirmation, undefined);
  assert.ok(!reply.content.includes("XRP"));
  assert.ok(!reply.content.includes("RLUSD"));
  assert.equal(f.operations.length, 0);
});

test("legacy generic HTTP 503 remains unknown without inventing a service outage and never treats a ready GET as permission to repay", async () => {
  const f = fixture(); await f.ready(); f.enableIssuer();
  f.setComplete(async () => {
    const sent = f.operations.at(-1)!;
    await checkoutRequest(f.state.connection!, "complete", f.state.checkout!.id, sent.body, sent.key, signal,
      async () => ({ status: 503, url: "https://api.merchant.example/ucp/checkout-sessions/c1/complete", body: {
        ucp: { version: "2026-08-25", status: "error" }, code: "payment_processing_unavailable", content: "private merchant diagnostic",
      } }));
    assert.fail("503 must throw");
  });
  const token = f.state.confirmation!.token;
  const reply = await f.turn("Confirm", [], { type: "confirm", token });
  assert.match(reply.content, /Payment outcome unknown/);
  assert.doesNotMatch(reply.content, /payment failed|No payment.*sent/);
  assert.ok(!JSON.stringify(reply).includes("private merchant diagnostic"));
  assert.equal(reply.shopping?.stage, "uncertain");
  assert.equal(reply.shopping?.confirmation, undefined);
  assert.equal(reply.shopping?.canCancel, false);
  assert.equal(reply.shopping?.checkout?.order, undefined);
  assert.equal(f.state.uncertain, true, "the same merchant 503 can also mean an unknown submission");
  const key = f.state.attempted;
  for (const action of [{ type: "status" }, { type: "confirm", token }] as ShoppingAction[]) {
    const again = await f.turn("Check", [], action);
    assert.match(again.content, /Payment outcome unknown/);
    assert.equal(again.shopping?.stage, "uncertain");
    assert.equal(again.shopping?.confirmation, undefined);
  }
  assert.equal(f.state.attempted, key);
  assert.equal(f.state.uncertain, true);
  assert.equal(f.issued.length, 1);
  assert.equal(f.operations.filter(o => o.op === "complete").length, 1);
});

test("conversation lock covers Complete I/O as well as issuance", async () => {
  const store = createShoppingStore(), entry = store.acquire("owner");
  const f = fixture(catalog, ["XRP", "RLUSD"], entry.state);
  await f.ready(); f.enableIssuer(); entry.release();
  let begin!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  f.setComplete(async () => { begin(); await pending; return checkoutBody("completed"); });
  const token = f.state.confirmation!.token, modelCount = f.modelCalls.length;
  const locked = store.acquire("owner", entry.id);
  const first = f.turn("Confirm", [], { type: "confirm", token }).finally(locked.release);
  await started;
  try {
    assert.equal(f.state.confirmation, undefined);
    assert.equal(f.state.uncertain, true);
    assert.equal(f.state.attempted, f.operations.at(-1)!.key);
    assert.throws(() => store.acquire("owner", entry.id), /shopping_busy/);
    assert.throws(() => store.reset("owner", entry.id), /shopping_busy/);
  } finally { finish(); }
  await first;
  const again = store.acquire("owner", entry.id);
  try { await f.turn("Duplicate click", [], { type: "confirm", token }); }
  finally { again.release(); }
  assert.equal(f.issued.length, 1);
  assert.equal(f.operations.filter(o => o.op === "complete").length, 1);
  assert.equal(f.modelCalls.length, modelCount);
});

test("timeout retains its attempt and private credential; only GET can reconcile to a completed order", async () => {
  const f = fixture(); await f.ready(); f.enableIssuer();
  f.setComplete(async () => { throw new Error("timeout with synthetic-unit-test-credential in unsafe diagnostic"); });
  const token = f.state.confirmation!.token;
  const reply = await f.turn("Confirm", [], { type: "confirm", token });
  assert.match(reply.content, /Payment outcome unknown.*do not pay again/);
  assert.equal(reply.shopping?.stage, "uncertain");
  const key = f.state.attempted;
  await f.turn("Duplicate click", [], { type: "confirm", token });
  assert.equal(f.state.checkout?.status, "ready_for_complete");
  assert.equal(f.state.uncertain, true, "ready does not resolve a lost Complete response");
  assert.equal(f.state.confirmation, undefined);
  await f.turn("Use XRP", [call("prepare_payment", { asset: "XRP" })]);
  await f.turn("Update", [call("update_checkout", { quantity: 2, buyer_email: null })]);
  await f.turn("Cancel", [], { type: "cancel" });
  assert.equal(f.state.paymentAsset, "RLUSD");
  assert.ok(!f.operations.some(o => o.op === "cancel" || o.op === "update"));
  assert.ok(f.state.paymentCredential);
  assert.ok(!JSON.stringify(f.modelCalls).includes("synthetic-unit-test-credential"));
  assert.ok(!JSON.stringify(f.history).includes("synthetic-unit-test-credential"));
  assert.ok(!JSON.stringify(f.state).includes("synthetic-unit-test-credential"));
  f.setRemote(checkoutBody("completed"));
  const reconciled = await f.turn("Check status", [], { type: "status" });
  assert.match(reconciled.content, /Purchase completed. Order order_1/);
  assert.equal(f.state.uncertain, false);
  assert.equal(f.state.paymentCredential, undefined);
  assert.equal(f.state.attempted, key);
  assert.equal(f.issued.length, 1);
  assert.equal(f.operations.filter(o => o.op === "complete").length, 1);
});

test("complete_in_progress is processing and status polling never resubmits", async () => {
  const f = fixture(); await f.ready(); f.enableIssuer();
  f.setComplete(async () => checkoutBody("complete_in_progress"));
  const token = f.state.confirmation!.token;
  const reply = await f.turn("Confirm", [], { type: "confirm", token });
  assert.match(reply.content, /Payment pending/);
  assert.equal(reply.shopping?.stage, "processing");
  assert.equal(reply.shopping?.checkout?.order, undefined);
  assert.equal(reply.shopping?.confirmation, undefined);
  const reads = f.operations.filter(o => o.op === "get").length;
  await f.turn("Status", [], { type: "status" });
  assert.equal(f.operations.filter(o => o.op === "get").length - reads, 3);
  await f.turn("Old click", [], { type: "confirm", token });
  assert.equal(f.operations.filter(o => o.op === "complete").length, 1);
  assert.equal(f.issued.length, 1);
  f.setRemote(checkoutBody("completed"));
  const completed = await f.turn("Status", [], { type: "status" });
  assert.match(completed.content, /Purchase completed. Order order_1/);
  assert.equal(f.state.uncertain, false);
});

test("a completed response without an order or an unexplained ready result remains uncertain", async () => {
  for (const remote of [{ ...checkoutBody("completed"), order: undefined }, checkoutBody()]) {
    const f = fixture(); await f.ready(); f.enableIssuer();
    f.setComplete(async () => remote);
    const token = f.state.confirmation!.token;
    const reply = await f.turn("Confirm", [], { type: "confirm", token });
    assert.match(reply.content, /Payment outcome unknown/);
    assert.equal(reply.shopping?.stage, "uncertain");
    assert.equal(reply.shopping?.checkout?.order, undefined);
    assert.equal(reply.shopping?.confirmation, undefined);
    assert.equal(f.state.uncertain, true);
    await f.turn("Old click", [], { type: "confirm", token });
    assert.equal(f.operations.filter(o => o.op === "complete").length, 1);
    assert.equal(f.issued.length, 1);
  }
});

test("a credential echoed into a projected checkout field cannot reach the model or browser", async () => {
  const f = fixture(); await f.ready(); f.enableIssuer();
  f.setComplete(async () => ({ ...checkoutBody("completed"), order: { id: "synthetic-unit-test-credential", permalink_url: "https://api.merchant.example/orders/order_1" } }));
  const reply = await f.turn("Confirm", [], { type: "confirm", token: f.state.confirmation!.token });
  assert.match(reply.content, /Payment outcome unknown/);
  assert.equal(reply.shopping?.checkout?.order, undefined);
  assert.equal(f.state.uncertain, true);
  await f.turn("Status", [call("get_checkout")]);
  assert.ok(!JSON.stringify(f.modelCalls).includes("synthetic-unit-test-credential"));
  assert.ok(!JSON.stringify(f.history).includes("synthetic-unit-test-credential"));
  assert.equal(f.operations.filter(o => o.op === "complete").length, 1);
});


test("confirmed order permalink and shopping references survive subsequent conversational turns", async () => {
  const f = fixture(); await f.ready(); f.enableIssuer();
  const catalogBefore = structuredClone(f.state.catalog), selectedBefore = structuredClone(f.state.selected);
  const reply = await f.turn("Confirm", [], { type: "confirm", token: f.state.confirmation!.token });
  const order = { id: "order_1", permalinkUrl: "https://api.merchant.example/orders/order_1" };
  assert.deepEqual(reply.shopping?.checkout?.order, order);
  assert.ok(reply.content.includes(order.permalinkUrl));
  assert.equal(reply.shopping?.confirmation, undefined); assert.equal(reply.shopping?.canCancel, false);
  await f.turn("Which report did I buy?", [text("The RLUSD report.")]);
  const context = JSON.parse(String(f.modelCalls.at(-1)!.instructions).split("Authoritative request context (untrusted text fields):\n")[1]);
  assert.deepEqual(context.checkout.order, order);
  assert.equal(context.selected.product.id, selectedBefore!.product.id);
  assert.deepEqual(f.state.catalog, catalogBefore); assert.deepEqual(f.state.selected, selectedBefore);
  assert.equal(f.operations.filter(o => o.op === "complete").length, 1); assert.equal(f.issued.length, 1);
});

test("HTTP 409/5xx and transport failures remain uncertain across repeated clicks, model calls and status reads", async () => {
  const scenarios = [409, 500, 502, 503, "timeout", "network_error", "invalid_json"] as const;
  for (const scenario of scenarios) {
    const f = fixture(); await f.ready(); f.enableIssuer();
    const selected = structuredClone(f.state.selected), catalog = structuredClone(f.state.catalog);
    let calls = 0;
    f.setComplete(async () => {
      const sent = f.operations.at(-1)!;
      await checkoutRequest(f.state.connection!, "complete", "c1", sent.body, sent.key, signal, async () => {
        calls++;
        if (typeof scenario === "string") throw new Error(`private diagnostic: ${scenario}`);
        return { status: scenario, url: "https://api.merchant.example/ucp/checkout-sessions/c1/complete",
          body: { ucp: { version: "2026-08-25", status: "error" }, code: "unrecognized_merchant_error", content: "private diagnostic" } };
      });
      assert.fail("Uncertain completion must not return success");
    });
    const token = f.state.confirmation!.token;
    const reply = await f.turn("Confirm", [], { type: "confirm", token });
    assert.equal(reply.shopping?.stage, "uncertain"); assert.match(reply.content, /Payment outcome unknown.*do not pay again/);
    assert.equal(reply.shopping?.checkout?.order, undefined); assert.equal(reply.shopping?.confirmation, undefined);
    assert.equal(reply.shopping?.canCancel, false); assert.ok(!JSON.stringify(reply).includes("private diagnostic"));
    const key = f.state.attempted;
    await f.turn("Old confirmation", [], { type: "confirm", token });
    await f.turn("Complete it again", [call("complete_checkout"), text()]);
    await f.turn("Status", [], { type: "status" });
    assert.equal(f.state.attempted, key); assert.equal(f.state.uncertain, true);
    assert.equal(f.state.confirmation, undefined); assert.equal(calls, 1);
    assert.equal(f.issued.length, 1); assert.equal(f.operations.filter(o => o.op === "complete").length, 1);
    assert.deepEqual(f.state.catalog, catalog); assert.deepEqual(f.state.selected, selected);
  }
});

test("missing or unsafe order permalink keeps the payment uncertain and cannot authorize another Complete", async () => {
  for (const permalink_url of [undefined, "http://merchant.example/orders/1", "javascript:alert(1)", "https://127.0.0.1/orders/1"]) {
    const f = fixture(); await f.ready(); f.enableIssuer();
    f.setComplete(async () => ({ ...checkoutBody("completed"), order: { id: "order_1", permalink_url: permalink_url as string } }));
    const token = f.state.confirmation!.token;
    const reply = await f.turn("Confirm", [], { type: "confirm", token });
    assert.equal(reply.shopping?.stage, "uncertain"); assert.equal(reply.shopping?.checkout?.order, undefined);
    assert.doesNotMatch(reply.content, /Purchase completed/);
    await f.turn("Repeat click", [], { type: "confirm", token });
    assert.equal(f.operations.filter(o => o.op === "complete").length, 1); assert.equal(f.issued.length, 1);
  }
});

test("a credential reflected in an order permalink cannot reach browser, history or model context", async () => {
  const f = fixture(); await f.ready(); f.enableIssuer();
  f.setComplete(async () => ({ ...checkoutBody("completed"), order: {
    id: "order_1", permalink_url: "https://api.merchant.example/orders/1?token=synthetic-unit-test-credential",
  } }));
  const reply = await f.turn("Confirm", [], { type: "confirm", token: f.state.confirmation!.token });
  assert.equal(reply.shopping?.stage, "uncertain"); assert.equal(reply.shopping?.checkout?.order, undefined);
  await f.turn("Status", [call("get_checkout")]);
  assert.ok(!JSON.stringify(f.modelCalls).includes("synthetic-unit-test-credential"));
  assert.ok(!JSON.stringify(f.history).includes("synthetic-unit-test-credential"));
  assert.equal(f.operations.filter(o => o.op === "complete").length, 1);
});

test("saving a new Agent ID can refresh readiness through status alone without model or payment calls", async () => {
  const f = fixture(); await f.ready();
  const priorApproval = f.state.confirmation!.token;
  const checkout = structuredClone(f.state.checkout);
  const modelCount = f.modelCalls.length, operationCount = f.operations.length;
  const newAgent = `agt_${"2".repeat(26)}`;
  const refreshed = await f.turn("Check my checkout status.", [], { type: "status" }, newAgent);
  assert.equal(f.modelCalls.length, modelCount);
  assert.deepEqual(f.operations.slice(operationCount).map(o => o.op), ["get"]);
  assert.deepEqual(f.state.checkout, checkout);
  assert.equal(refreshed.shopping?.buyerEmailProvided, true);
  assert.ok(refreshed.shopping?.confirmation); assert.notEqual(refreshed.shopping.confirmation, priorApproval);
  assert.equal(f.state.confirmation?.agentHash, fingerprint(newAgent));
  assert.equal(f.issued.length, 0); assert.equal(f.events.includes("issue"), false);
});


for (const [details, expected, uncertain] of [
  [{ status: "rejected", code: "spending_policy_unavailable" }, /Spending policy unavailable/, false],
  [{ status: "rejected", code: "spending_limit_exceeded" }, /Spending limit exceeded/, false],
  [{ status: "rejected", code: "agent_authorization_denied" }, /Agent account unavailable/, false],
  [{ status: "rejected", code: "signing_authority_unavailable" }, /Wallet authorization unavailable/, false],
  [{ status: "not_sent", code: "payment_service_unavailable" }, /Payment service unavailable/, false],
  [{ status: "unknown", code: "signing_authority_invalid" }, /Payment outcome unknown.*do not pay again/, true],
  [{ status: "unknown" }, /Payment outcome unknown/, true],
  [{ status: "confirmed" }, /Payment confirmed; order pending.*do not pay again/, true],
] as const) {
  test(`structured ${details.status}/${"code" in details ? details.code : "no_code"} remains consistent across refresh, stale clicks, and model turns`, async () => {
    const f = fixture(); await f.ready(); f.enableIssuer();
    f.setComplete(async () => {
      const sent = f.operations.at(-1)!;
      await checkoutRequest(f.state.connection!, "complete", "c1", sent.body, sent.key, signal, async () => ({ status: 503, url: connection.endpoint, body: {
        ucp: { version: "2026-08-25", status: "error" }, code: "payment_processing_unavailable", content: "private account details",
        hashtrion_payment: { ...details, signingKey: "private-key" },
      } }));
      assert.fail("error response must throw");
    });
    const token = f.state.confirmation!.token;
    const first = await f.turn("Confirm", [], { type: "confirm", token });
    assert.match(first.content, expected); assert.deepEqual(first.shopping?.paymentStatus, details);
    assert.equal(f.state.uncertain, uncertain);
    if (details.status === "rejected" && details.code === "spending_limit_exceeded") {
      assert.ok(first.shopping?.confirmation); assert.equal(first.shopping?.canRetry, true);
      assert.equal(f.state.confirmation?.retryAttempt, f.state.attempted);
    } else assert.equal(first.shopping?.confirmation, undefined);
    assert.equal(first.shopping?.canCancel, false); assert.equal(first.shopping?.checkout?.status, "ready_for_complete");
    const key = f.state.attempted;
    for (const action of [{ type: "status" }, { type: "confirm", token }] as ShoppingAction[]) {
      const again = await f.turn("Check", [], action);
      assert.equal(again.content, first.content); assert.equal(again.shopping?.confirmation, undefined);
    }
    const chat = await f.turn("What happened?", [text("Invented payment success or failure must not be displayed.")]);
    assert.equal(chat.content, first.content);
    assert.equal(f.state.attempted, key); assert.equal(f.issued.length, 1);
    assert.equal(f.operations.filter(o => o.op === "complete").length, 1);
    assert.ok(!JSON.stringify(chat).includes("private"));
  });
}

test("a persisted rejection from Get Checkout cannot mint approval or trigger a payment in a fresh conversation", async () => {
  const f = fixture(); await f.ready(); f.enableIssuer();
  const token = f.state.confirmation!.token;
  f.setRemote({ ...checkoutBody(), hashtrion_payment: { status: "rejected", code: "spending_policy_unavailable" } } as ReturnType<typeof checkoutBody>);
  const reply = await f.turn("Check", [], { type: "status" });
  assert.match(reply.content, /Spending policy unavailable/); assert.equal(reply.shopping?.confirmation, undefined);
  await f.turn("Old confirm", [], { type: "confirm", token });
  assert.equal(f.issued.length, 0); assert.equal(f.operations.filter(o => o.op === "complete").length, 0);
});

test("bare payment_failed is not confirmed blockchain failure and never permits another Complete", async () => {
  const f = fixture(); await f.ready(); f.enableIssuer();
  f.setComplete(async () => { throw new CheckoutError("payment_failed"); });
  const token = f.state.confirmation!.token;
  const reply = await f.turn("Confirm", [], { type: "confirm", token });
  assert.match(reply.content, /Payment outcome unknown/); assert.doesNotMatch(reply.content, /payment failed|payment was not/);
  await f.turn("Retry", [], { type: "confirm", token });
  assert.equal(f.operations.filter(o => o.op === "complete").length, 1);
});

for (const code of ["credential_forbidden", "credential_service_unavailable", "credential_invalid"]) {
  test(`authorization-only ${code} is not an uncertain payment and never sends Complete`, async () => {
    const f = fixture(); await f.ready(); let issues = 0;
    f.setIssuer(async () => { issues++; throw new CheckoutError(code); });
    const token = f.state.confirmation!.token;
    const reply = await f.turn("Confirm", [], { type: "confirm", token });
    assert.equal(reply.shopping?.paymentStatus?.status, "not_sent");
    assert.match(paymentFeedback(reply.shopping!)!.message, /No payment request was sent to the merchant/);
    assert.equal(f.state.uncertain, false); assert.doesNotMatch(reply.content, /Payment outcome unknown/);
    await f.turn("Old click", [], { type: "confirm", token });
    assert.equal(issues, 1); assert.equal(f.operations.filter(o => o.op === "complete").length, 0);
  });
}


const policyRejection = { status: "rejected", code: "spending_limit_exceeded" } as const;
async function rejectedCheckout(buyerFingerprint?: string) {
  const f = fixture(); await f.ready(); f.enableIssuer();
  if (buyerFingerprint) { f.state.connection!.buyerFingerprint = buyerFingerprint; await f.turn("Review buyer", [], { type: "status" }); }
  const remote = { ...checkoutBody(), hashtrion_payment: policyRejection };
  f.setComplete(async () => {
    f.setRemote(remote);
    throw new CheckoutError("payment_processing_unavailable", policyRejection);
  });
  const reply = await f.turn("Confirm", [], { type: "confirm", token: f.state.confirmation!.token });
  assert.equal(reply.shopping?.canRetry, true);
  assert.equal(f.state.paymentAttempts?.at(-1)?.id, f.state.attempted);
  return f;
}

test("explicit policy retry preserves purchase and rejected receipt, uses a fresh credential and new key, and succeeds", async () => {
  const f = await rejectedCheckout();
  const prior = structuredClone(f.state.paymentAttempts![0]);
  const original = { checkout: f.state.checkout!.id, items: structuredClone(f.state.checkout!.items), selected: structuredClone(f.state.selected), buyer: f.state.buyerEmail, asset: f.state.paymentAsset };
  const historyLength = f.history.length;
  let newCredentials = 0;
  f.setIssuer(async context => {
    f.issued.push(context); newCredentials++;
    return { type: "hashtrion_authorization", token: "synthetic-fresh-retry-credential", expiry: "2099-01-01T00:00:00Z" };
  });
  f.setComplete(async () => checkoutBody("completed"));
  const action: ShoppingAction = { type: "retry", token: f.state.confirmation!.token };
  const result = await f.turn("Try Again", [], action);
  assert.equal(result.shopping?.stage, "completed"); assert.equal(result.shopping?.canRetry, false);
  assert.equal(newCredentials, 1); assert.equal(f.issued.length, 2);
  const requests = f.operations.filter(o => o.op === "complete");
  assert.equal(requests.length, 2); assert.equal(requests[0].id, original.checkout); assert.equal(requests[1].id, original.checkout);
  assert.notEqual(requests[0].key, requests[1].key);
  const instrument = (requests[1].body as { payment: { instruments: { id: string; credential: { token: string } }[] } }).payment.instruments[0];
  assert.equal(instrument.id, requests[1].key); assert.equal(f.issued[1].idempotencyKey, requests[1].key);
  assert.equal(instrument.credential.token, "synthetic-fresh-retry-credential");
  assert.equal(f.issued[1].checkout.id, original.checkout); assert.equal(f.issued[1].agentId, agentId);
  assert.deepEqual(f.state.checkout!.items, original.items); assert.deepEqual(f.state.selected, original.selected);
  assert.equal(f.state.buyerEmail, original.buyer); assert.equal(f.state.paymentAsset, original.asset);
  assert.equal(f.operations.filter(o => o.op === "create").length, 1); assert.equal(f.operations.filter(o => ["update", "cancel"].includes(o.op)).length, 0);
  assert.deepEqual(f.state.paymentAttempts![0], { ...prior, retryConsumed: true });
  assert.equal(f.state.paymentAttempts!.length, 2); assert.ok(f.history.length > historyLength);
  assert.ok(!JSON.stringify(result).includes("synthetic-fresh-retry-credential"));
  await f.turn("Duplicate retry", [], action);
  assert.equal(f.operations.filter(o => o.op === "complete").length, 2); assert.equal(newCredentials, 1);
});

test("concurrent retry click consumes approval before credential issuance and dispatch", async () => {
  const f = await rejectedCheckout();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  let issued = 0;
  f.setIssuer(async () => { issued++; entered(); await pending; return { type: "hashtrion_authorization", token: "synthetic-concurrent-retry", expiry: "2099-01-01T00:00:00Z" }; });
  f.setComplete(async () => checkoutBody("completed"));
  const action: ShoppingAction = { type: "retry", token: f.state.confirmation!.token };
  const first = f.turn("Try Again", [], action); await started;
  await f.turn("Duplicate", [], action);
  release(); await first;
  assert.equal(issued, 1); assert.equal(f.operations.filter(o => o.op === "complete").length, 2);
});

for (const fault of ["unknown", "timeout", "network", "failed", "pending", "confirmed", "other_rejection"] as const) {
  test(`second attempt ${fault} cannot be retried using the earlier spending-limit rejection`, async () => {
    const f = await rejectedCheckout();
    const oldReceipt = structuredClone(f.state.paymentAttempts![0]);
    const stale = { ...checkoutBody(), hashtrion_payment: policyRejection };
    f.setComplete(async () => {
      if (fault === "pending") return checkoutBody("complete_in_progress");
      if (fault === "timeout") throw new DOMException("Synthetic timeout", "TimeoutError");
      if (fault === "network") throw new TypeError("Synthetic connection lost");
      if (fault === "failed") throw new CheckoutError("payment_failed");
      throw new CheckoutError("payment_processing_unavailable", fault === "confirmed" ? { status: "confirmed" } : fault === "other_rejection" ? { status: "rejected", code: "spending_asset_denied" } : { status: "unknown" });
    });
    const oldToken = f.state.confirmation!.token;
    await f.turn("Try Again", [], { type: "retry", token: oldToken });
    assert.equal(shoppingView(f.state).canRetry, false);
    f.setRemote(stale);
    const read = await f.turn("Check status", [], { type: "status" });
    assert.equal(read.shopping?.canRetry, false); assert.equal(read.shopping?.confirmation, undefined);
    if (["unknown", "timeout", "network", "failed", "pending"].includes(fault)) assert.equal(read.shopping?.paymentStatus?.status, "unknown");
    await f.turn("Stale retry", [], { type: "retry", token: oldToken });
    assert.equal(f.operations.filter(o => o.op === "complete").length, 2); assert.equal(f.issued.length, 2);
    assert.deepEqual(f.state.paymentAttempts![0].result, oldReceipt.result);
  });
}

for (const status of ["completed", "canceled", "expired", "complete_in_progress", "missing_evidence", "unknown"] as const) {
  test(`retry preflight blocks ${status} without issuing another credential`, async () => {
    const f = await rejectedCheckout(); const action: ShoppingAction = { type: "retry", token: f.state.confirmation!.token };
    f.setRemote(status === "expired" ? { ...checkoutBody(), expires_at: "2000-01-01T00:00:00Z", hashtrion_payment: policyRejection }
      : status === "unknown" ? { ...checkoutBody(), hashtrion_payment: { status: "unknown" } }
      : checkoutBody(status === "missing_evidence" ? "ready_for_complete" : status));
    const result = await f.turn("Try Again", [], action);
    assert.equal(f.issued.length, 1); assert.equal(f.operations.filter(o => o.op === "complete").length, 1);
    assert.equal(result.shopping?.canRetry, false);
    if (status === "expired") assert.match(result.shopping?.retryUnavailableReason ?? "", /expired/);
    if (status === "canceled") assert.match(result.shopping?.retryUnavailableReason ?? "", /canceled/);
    f.setRemote({ ...checkoutBody(), hashtrion_payment: policyRejection });
    if (status !== "expired") {
      await f.turn("Stale status", [], { type: "status" });
      assert.equal(shoppingView(f.state).canRetry, false);
    }
  });
}

test("GET-only rejection and forged/stale confirmation cannot authorize retry", async () => {
  const f = fixture(); await f.ready(); f.enableIssuer();
  f.setRemote({ ...checkoutBody(), hashtrion_payment: policyRejection });
  await f.turn("Status", [], { type: "status" });
  assert.equal(shoppingView(f.state).canRetry, false);
  await f.turn("Retry", [], { type: "retry", token: "forged" });
  assert.equal(f.issued.length, 0);
  const rejected = await rejectedCheckout();
  await rejected.turn("Forged", [], { type: "retry", token: "forged" });
  await rejected.turn("Model retries", [call("complete_checkout"), text()]);
  assert.equal(rejected.issued.length, 1); assert.equal(rejected.operations.filter(o => o.op === "complete").length, 1);
});

test("a second direct policy rejection permits only a newly confirmed retry for that exact attempt", async () => {
  const f = await rejectedCheckout(); const firstKey = f.state.attempted;
  const action: ShoppingAction = { type: "retry", token: f.state.confirmation!.token };
  const result = await f.turn("Try Again", [], action);
  assert.equal(result.shopping?.canRetry, true); assert.notEqual(f.state.attempted, firstKey);
  assert.equal(f.state.confirmation?.retryAttempt, f.state.attempted);
  assert.equal(f.state.paymentAttempts!.length, 2);
  await f.turn("Stale first retry", [], action);
  assert.equal(f.operations.filter(o => o.op === "complete").length, 2);
});

test("retry material changes require fresh approval before issuance", async () => {
  const f = await rejectedCheckout(); const action: ShoppingAction = { type: "retry", token: f.state.confirmation!.token };
  f.setRemote({ ...checkoutBody("ready_for_complete", 2), hashtrion_payment: policyRejection });
  const changed = await f.turn("Try Again", [], action);
  assert.equal(f.issued.length, 1); assert.match(changed.shopping?.notice ?? "", /changed/);
  assert.equal(changed.shopping?.canRetry, true); assert.notEqual(changed.shopping?.confirmation, action.token);
  f.setComplete(async () => checkoutBody("completed", 2));
  await f.turn("Approve updated summary", [], { type: "retry", token: changed.shopping!.confirmation });
  assert.equal(f.issued.length, 2); assert.equal(f.state.checkout?.items[0].quantity, 2);
});

test("Agent ID and local buyer/asset changes invalidate retry approval", async () => {
  for (const change of ["agent", "buyer", "asset"] as const) {
    const f = await rejectedCheckout(); const action: ShoppingAction = { type: "retry", token: f.state.confirmation!.token };
    if (change === "buyer") f.state.buyerEmail = "different@example.com";
    if (change === "asset") f.state.paymentAsset = "XRP";
    await f.turn("Try Again", [], action, change === "agent" ? `agt_${"B".repeat(26)}` : agentId);
    assert.equal(f.issued.length, 1); assert.equal(f.operations.filter(o => o.op === "complete").length, 1);
  }
});

test("retry credential timeout cannot reuse the earlier rejected attempt", async () => {
  const f = await rejectedCheckout();
  f.setIssuer(async () => { throw new CheckoutError("credential_request_failed"); });
  await f.turn("Try Again", [], { type: "retry", token: f.state.confirmation!.token });
  const result = await f.turn("Check status", [], { type: "status" });
  assert.equal(result.shopping?.canRetry, false); assert.equal(result.shopping?.paymentStatus?.status, "unknown");
  assert.equal(f.operations.filter(o => o.op === "complete").length, 1);
});


for (const change of ["amount", "currency"] as const) {
  test(`retry rechecks merchant ${change} before issuing a credential`, async () => {
    const f = await rejectedCheckout(); const action: ShoppingAction = { type: "retry", token: f.state.confirmation!.token };
    f.setRemote({ ...checkoutBody(), ...(change === "amount" ? { totals: [{ type: "total", amount: 500 }] } : { currency: "AUD" }), hashtrion_payment: policyRejection });
    const result = await f.turn("Try Again", [], action);
    assert.equal(f.issued.length, 1); assert.equal(f.operations.filter(o => o.op === "complete").length, 1);
    assert.match(result.shopping?.notice ?? "", /changed/);
    assert.notEqual(result.shopping?.confirmation, action.token);
  });
}

test("retry binds to merchant buyer fields privately and detects buyer changes during GET", async () => {
  let buyer = { email: "buyer@example.com", first_name: "Fixture", last_name: "Buyer", phone_number: "+12025550123" };
  const originalBuyerFingerprint = fingerprint([buyer.first_name, buyer.last_name, buyer.email, buyer.phone_number]);
  const f = await rejectedCheckout(originalBuyerFingerprint);
  const request: typeof checkoutRequest = (connection, operation, id, body, key, requestSignal) => checkoutRequest(connection, operation, id, body, key, requestSignal,
    async () => ({ status: 200, url: connection.endpoint, body: { ...checkoutBody(), buyer,
      hashtrion_payment: policyRejection, ucp: { ...checkoutBody().ucp, payment_handlers: handlerRegistry() } } }));
  const first = await request(f.state.connection!, "get", "c1", undefined, "read", signal);
  const buyerFingerprint = f.state.connection!.buyerFingerprint;
  assert.ok(buyerFingerprint); assert.ok(!JSON.stringify(first).includes(buyer.email));
  await f.turn("Status", [], { type: "status" });
  const action: ShoppingAction = { type: "retry", token: f.state.confirmation!.token };
  let issues = 0;
  const options = { state: f.state, model: "fixture", responses: { create: async () => text() }, signal, agentId, action, request,
    issue: async () => { issues++; throw new Error("Must not issue after buyer change"); } };
  assert.equal(authorizeConfirmation(options), true);
  buyer = { ...buyer, email: "changed@example.com" };
  await assert.rejects(executeShoppingTool("complete_checkout", {}, options, f.history, true), { code: "checkout_changed" });
  assert.equal(issues, 0); assert.notEqual(f.state.connection!.buyerFingerprint, buyerFingerprint);
  const refreshed = await f.turn("Status", [], { type: "status" });
  assert.equal(refreshed.shopping?.canRetry, false);
  assert.match(refreshed.shopping?.retryUnavailableReason ?? "", /buyer information changed/);
  assert.ok(!JSON.stringify(shoppingView(f.state)).includes(buyer.email));
  assert.ok(!JSON.stringify(shoppingView(f.state)).includes(f.state.connection!.buyerFingerprint!));
});

test("a lost retry preflight response consumes approval without dispatch or automatic recovery", async () => {
  const f = await rejectedCheckout(); const action: ShoppingAction = { type: "retry", token: f.state.confirmation!.token };
  let issues = 0;
  const options = { state: f.state, model: "fixture", responses: { create: async () => text() }, signal, agentId, action,
    request: async () => { throw new TypeError("Synthetic GET interruption"); },
    issue: async () => { issues++; throw new Error("Must not issue"); } };
  await assert.rejects(executeShoppingTool("complete_checkout", {}, options, f.history, true), /GET interruption/);
  const result = await f.turn("Status", [], { type: "status" });
  assert.equal(result.shopping?.canRetry, false); assert.equal(issues, 0);
  assert.equal(f.operations.filter(o => o.op === "complete").length, 1);
});
