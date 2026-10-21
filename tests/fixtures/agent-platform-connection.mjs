import assert from "node:assert/strict";
import { mock } from "node:test";
import { safePublicUrl } from "../../src/lib/server/safe-http.ts";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/server/auth.ts";

const calls = [];
let result = { status: 200, body: true };
let failure;
mock.module("../../src/lib/server/safe-http.ts", {
  namedExports: {
    safePublicUrl,
    requestUcpJson: async (...args) => {
      calls.push(args);
      if (failure) throw failure;
      return result;
    },
  },
});
globalThis.fetch = async () => assert.fail("No real network requests in this test.");
const { POST } = await import("../../src/app/api/agent-platform-connection/route.ts");
const agentId = "agt_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken()}`;
function request(body = { agentId }, headers = {}, signal) {
  return new Request("https://agent.example/api/agent-platform-connection", {
    method: "POST", signal,
    headers: { host: "agent.example", origin: "https://agent.example", "content-type": "application/json", cookie, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
for (const base of ["https://platform.example", "https://platform.example/", "https://platform.example/api", "https://platform.example/api/"]) {
  process.env.CONNECTION_API_BASE_URL = base;
  const incoming = request();
  const response = await POST(incoming);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "true");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const [url, method, body, headers, signal, policy] = calls.at(-1);
  assert.equal(url, "https://platform.example/api/AppClientAuth/mock/agent-platform-connection");
  assert.equal(method, "POST");
  assert.deepEqual(body, { agentId });
  assert.equal(headers["UCP-Agent"], 'profile="https://agent.example/.well-known/ucp"');
  assert.ok(headers["Request-Id"]);
  assert.equal(signal, incoming.signal);
  assert.deepEqual(policy, { discardErrorBody: true });
}
const before = calls.length;
for (const [incoming, status] of [
  [request({ agentId }, { cookie: "" }), 401],
  [request({ agentId }, { origin: "https://other.example" }), 403],
  [request({ agentId }, { "content-type": "text/plain" }), 415],
  [request({ agentId: "not-an-agent" }), 400],
  [request({}), 400],
  [request({ agentId, endpoint: "https://other.example" }), 400],
  [request("invalid JSON"), 400],
  [request("x".repeat(1025)), 413],
]) {
  assert.equal((await POST(incoming)).status, status);
}
assert.equal(calls.length, before);
for (const base of ["", "http://platform.example/api", "https://127.0.0.1/api", "https://platform.example/other", "https://platform.example/api?key=value"]) {
  process.env.CONNECTION_API_BASE_URL = base;
  assert.equal((await POST(request())).status, 502);
}
assert.equal(calls.length, before);
process.env.CONNECTION_API_BASE_URL = "https://platform.example/api";
for (const body of [false, "true", 1, null, { data: true }, { success: true }]) {
  result = { status: 200, body };
  assert.equal((await POST(request())).status, 502);
}
for (const status of [201, 400, 401, 403, 404, 500]) {
  result = { status, body: true };
  assert.equal((await POST(request())).status, 502);
}
failure = new Error("upstream details must not be exposed");
const failed = await POST(request());
assert.equal(failed.status, 502);
assert.ok(!(await failed.text()).includes(failure.message));
console.log("Agent Platform Connection route verified.");
