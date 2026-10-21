import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mock } from "node:test";
import * as React from "react";

// Exercise the actual Chat handlers and effects, committing refs before effects.
const slots = [];
let cursor = 0, effects = [];
mock.module("react", {
  namedExports: {
    ...React,
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(callback, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        slots[index] = { dependencies, cleanup: previous?.cleanup };
        effects.push(() => {
          slots[index].cleanup?.();
          slots[index].cleanup = callback();
        });
      }
    },
  },
});
mock.module("next/navigation", { namedExports: { useRouter: () => ({ refresh() {} }) } });
registerHooks({ load(url, context, next) {
  if (url.endsWith(".module.css")) return {
    format: "module", source: "export default new Proxy({}, {get: (_, key) => key});", shortCircuit: true,
  };
  return next(url, context);
} });
const { default: Chat } = await import("../../src/app/chat.tsx");
const { default: AgentIdModal } = await import("../../src/app/agent-id-modal.tsx");
const { default: ShoppingContext } = await import("../../src/app/shopping-context.tsx");
const scenario = process.argv[2];
const frames = new Map();
let frameId = 0, modalOpen = false, tree, respond, reject;
const calls = [], focusCalls = [];
const body = {};
globalThis.document = { body, activeElement: body, querySelector: () => modalOpen ? {} : null };
globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
const history = scenario === "history-limit"
  ? Array.from({ length: 38 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "Previous message." }))
  : [];
globalThis.sessionStorage = { getItem: () => JSON.stringify(history), setItem() {}, removeItem() {} };
globalThis.fetch = (url, options) => {
  calls.push({ url, options });
  return new Promise((resolve, fail) => { respond = resolve; reject = fail; });
};
const input = {
  disabled: false,
  focus(options) {
    assert.equal(this.disabled, false, "Never focus the disabled textarea");
    focusCalls.push(options);
    document.activeElement = this;
  },
};
function walk(node, predicate) {
  if (!node || typeof node !== "object") return undefined;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const found = walk(child, predicate);
    if (found) return found;
  }
}
const field = () => walk(tree, node => node.type === "textarea");
function render() {
  cursor = 0;
  const previous = field();
  tree = Chat();
  const current = field();
  if (current) {
    current.props.ref.current = input;
    input.disabled = current.props.disabled;
    if (input.disabled && document.activeElement === input) document.activeElement = body;
  } else if (previous) {
    previous.props.ref.current = null;
  }
  const queued = effects;
  effects = [];
  queued.forEach(effect => effect());
}
function flushFrames() {
  const queued = [...frames.values()];
  frames.clear();
  queued.forEach(callback => callback());
}
const shopping = { stage: "review", checkout: { id: "checkout_1", status: "incomplete" } };
function reply(status = 200) {
  respond(Response.json({ conversationId: "conversation_1", message: {
    role: "assistant", content: "Checkout updated.", shopping,
  } }, { status }));
}
function submit() {
  field().props.onChange({ target: { value: "buyer@example.test" } });
  render();
  document.activeElement = input;
  const waiting = walk(tree, node => node.type === "form").props.onSubmit({ preventDefault() {} });
  render();
  assert.equal(input.disabled, true);
  flushFrames();
  assert.equal(focusCalls.length, 0);
  return waiting;
}
render();
flushFrames();
render();
assert.equal(input.disabled, false);
assert.equal(focusCalls.length, 0, "Mount alone must not take focus");

if (scenario.startsWith("agent-")) {
  if (scenario === "agent-refresh") {
    const waiting = submit();
    reply();
    await waiting;
    render();
    flushFrames();
    focusCalls.length = 0;
  }
  const trigger = {};
  document.activeElement = trigger;
  walk(tree, node => node.props?.["aria-haspopup"] === "dialog").props.onClick();
  render();
  modalOpen = true;
  document.activeElement = { name: "modal-input" };
  const modal = walk(tree, node => node.type === AgentIdModal);
  if (scenario === "agent-cancel") modal.props.onClose();
  else modal.props.onSave("agt_ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  render();
  // Native dialog cleanup restores the opener before the next animation frame.
  modalOpen = false;
  document.activeElement = trigger;
  flushFrames();
  if (scenario === "agent-refresh") {
    assert.equal(input.disabled, true);
    assert.equal(focusCalls.length, 0, "Wait until checkout refresh finishes");
    assert.equal(JSON.parse(calls.at(-1).options.body).action.type, "status");
    reply();
    await new Promise(resolve => setImmediate(resolve));
    render();
    flushFrames();
  }
  assert.equal(focusCalls.length, scenario === "agent-cancel" ? 0 : 1);
  assert.equal(!!walk(tree, node => node.type === AgentIdModal), false);
} else {
  const waiting = submit();
  if (scenario === "other-input" || scenario === "other-button") document.activeElement = { name: scenario };
  if (scenario === "open-modal") modalOpen = true;
  if (scenario === "network-error") reject(new Error("offline"));
  else reply(scenario === "session-ended" ? 401 : 200);
  await waiting;
  assert.equal(focusCalls.length, 0, "Focus must wait for the enabled DOM commit");
  render();
  if (scenario === "already-focused") document.activeElement = input;
  flushFrames();
  const shouldFocus = ["reply", "network-error", "checkout-action"].includes(scenario);
  assert.equal(focusCalls.length, shouldFocus ? 1 : 0);
  if (scenario === "network-error") assert.equal(field().props.value, "buyer@example.test");
  if (scenario === "history-limit") assert.equal(input.disabled, true);
  if (scenario === "checkout-action") {
    focusCalls.length = 0;
    document.activeElement = { name: "check-status" };
    walk(tree, node => node.type === ShoppingContext).props.onAction({ type: "status" });
    render();
    assert.equal(input.disabled, true);
    assert.equal(JSON.parse(calls.at(-1).options.body).action.type, "status");
    reply();
    await new Promise(resolve => setImmediate(resolve));
    render();
    flushFrames();
    assert.equal(focusCalls.length, 1);
  }
}
for (const options of focusCalls) assert.deepEqual(options, { preventScroll: true });
const count = focusCalls.length;
render();
flushFrames();
if (field() && !input.disabled) {
  field().props.onChange({ target: { value: "Continue typing" } });
  render();
  flushFrames();
}
assert.equal(focusCalls.length, count, "Renders and typing must not reset focus or the caret");
console.log(`Chat focus verified: ${scenario}`);
