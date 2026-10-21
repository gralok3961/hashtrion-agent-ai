import assert from "node:assert/strict";
import { mock } from "node:test";

const calls = [];
mock.module("../../src/lib/server/chat-service.ts", {
  namedExports: {
    runChat: async (messages, options) => {
      calls.push({ messages, options });
      return { role: "assistant", content: "Mocked context response." };
    },
  },
});
globalThis.fetch = async () => assert.fail("Agent ID context tests must never make network requests.");
const { POST } = await import("../../src/app/api/chat/route.ts");
const { createSessionToken, SESSION_COOKIE_NAME } = await import("../../src/lib/server/auth.ts");
const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken()}`;
const messages = [{ role: "user", content: "Hello." }];
function request(agentId) {
  return new Request("https://agent.example/api/chat", {
    method: "POST",
    headers: { host: "agent.example", origin: "https://agent.example", "content-type": "application/json", cookie },
    body: JSON.stringify({ messages, ...(agentId === undefined ? {} : { agentId }) }),
  });
}
const firstId = "agt_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const secondId = `agt_${"2".repeat(26)}`;
const concurrent = await Promise.all([POST(request(firstId)), POST(request(secondId))]);
assert.deepEqual(concurrent.map(response => response.status), [200, 200]);
assert.equal((await POST(request())).status, 200);
assert.equal(calls.length, 3);
assert.deepEqual(calls.map(call => call.options.agentId), [firstId, secondId, undefined]);
for (const call of calls) {
  assert.deepEqual(call.messages, messages);
  assert.ok(!JSON.stringify(call.messages).includes("agentId"));
}
assert.notEqual(calls[0].options, calls[1].options);
console.log("Agent ID request context verified.");
