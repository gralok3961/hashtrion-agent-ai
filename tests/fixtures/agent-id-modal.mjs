import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mock } from "node:test";
import * as React from "react";

// Execute the actual component and its handlers with deterministic hook state.
let slots = [], cursor = 0, effects = [];
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
    useEffect(callback) {
      const index = cursor++;
      if (!(index in slots)) { slots[index] = true; effects.push(callback); }
    },
  },
});
registerHooks({ load(url, context, next) {
  if (url.endsWith(".module.css")) return {
    format: "module", source: "export default new Proxy({}, {get: (_, key) => key});", shortCircuit: true,
  };
  return next(url, context);
} });
const { default: AgentIdModal } = await import("../../src/app/agent-id-modal.tsx");
const previousId = "agt_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const nextId = `agt_${"2".repeat(26)}`;
let savedId, saves, closed, calls, respond, reject, cleanup;
globalThis.document = { activeElement: null };
globalThis.HTMLElement = class {};
function walk(node, predicate) {
  if (!node || typeof node !== "object") return undefined;
  if (predicate(node)) return node;
  const children = [node.props?.children].flat(Infinity);
  for (const child of children) { const found = walk(child, predicate); if (found) return found; }
}
function render() {
  cursor = 0;
  return AgentIdModal({ agentId: savedId, onSave(value) { savedId = value; saves++; closed = true; }, onClose() { closed = true; } });
}
function start() {
  slots = []; effects = []; savedId = previousId; saves = 0; closed = false; calls = [];
  globalThis.fetch = (url, options) => {
    calls.push({ url, options });
    return new Promise((resolve, fail) => { respond = resolve; reject = fail; });
  };
  let tree = render();
  cleanup = effects[0]();
  walk(tree, node => node.type === "input").props.onChange({ target: { value: `  ${nextId}  ` } });
  tree = render();
  return walk(tree, node => node.type === "form").props.onSubmit;
}
const event = { preventDefault() {} };
let submit = start();
const waiting = submit(event);
let tree = render();
const button = walk(tree, node => node.type === "button" && node.props.type === "submit");
assert.equal(button.props.disabled, true);
assert.equal(button.props["aria-busy"], true);
assert.ok(walk(button, node => node.props?.className === "saveSpinner"));
assert.equal(walk(tree, node => node.type === "input").props.disabled, true);
await submit(event);
assert.equal(calls.length, 1);
assert.equal(saves, 0);
assert.equal(savedId, previousId);
assert.equal(closed, false);
assert.equal(calls[0].url, "/api/agent-platform-connection");
assert.equal(calls[0].options.method, "POST");
assert.deepEqual(JSON.parse(calls[0].options.body), { agentId: nextId });
respond(Response.json(true));
await waiting;
assert.equal(saves, 1);
assert.equal(savedId, nextId);
assert.equal(closed, true);
cleanup();

for (const outcome of [false, "true", null, { data: true }, "invalid-json", "http-error", "network-error"]) {
  submit = start();
  const pending = submit(event);
  if (outcome === "network-error") reject(new Error("offline"));
  else if (outcome === "http-error") respond(Response.json(true, { status: 500 }));
  else if (outcome === "invalid-json") respond(new Response("not JSON"));
  else respond(Response.json(outcome));
  await pending;
  tree = render();
  assert.equal(savedId, previousId);
  assert.equal(saves, 0);
  assert.equal(closed, false);
  assert.ok(walk(tree, node => node.props?.role === "alert"));
  assert.equal(walk(tree, node => node.type === "button" && node.props.type === "submit").props.disabled, false);
  const retry = walk(tree, node => node.type === "form").props.onSubmit(event);
  assert.equal(calls.length, 2);
  respond(Response.json(true));
  await retry;
  assert.equal(savedId, nextId);
  assert.equal(saves, 1);
  cleanup();
}
submit = start();
const canceled = submit(event);
cleanup();
assert.equal(calls[0].options.signal.aborted, true);
respond(Response.json(true));
await canceled;
assert.equal(saves, 0);
assert.equal(savedId, previousId);
console.log("Agent ID modal Save behavior verified.");
