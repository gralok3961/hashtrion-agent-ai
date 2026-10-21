import assert from "node:assert/strict";
import test from "node:test";
import { refreshShoppingStatus, ShoppingRefreshError } from "../src/lib/shopping-refresh";

test("Agent ID refresh sends only a status action and returns the new confirmation without chat history or prior approval", async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  const request: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, "/api/chat"); assert.equal(init?.signal, signal);
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.action, { type: "status" });
    assert.equal(body.agentId, "agt_ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    assert.equal(body.conversationId, "conversation"); assert.equal(body.confirmation, undefined);
    assert.deepEqual(body.messages, [{ role: "user", content: "Check my checkout status." }]);
    return Response.json({ conversationId: "conversation", message: { shopping: { stage: "review", checkout: { id: "checkout" }, confirmation: "new" } } });
  };
  const result = await refreshShoppingStatus("conversation", "checkout", "agt_ABCDEFGHIJKLMNOPQRSTUVWXYZ", signal, request);
  assert.equal(result.confirmation, "new"); assert.equal(calls, 1);
});

test("refresh fails closed on lost sessions, wrong checkout, network errors and aborts with no retry", async () => {
  for (const fault of ["401", "409", "wrong_checkout", "network", "abort"]) {
    let calls = 0;
    const request: typeof fetch = async () => {
      calls++;
      if (fault === "network") throw new TypeError("Synthetic network failure");
      if (fault === "abort") throw new DOMException("Synthetic abort", "AbortError");
      if (fault === "wrong_checkout") return Response.json({ conversationId: "conversation", message: { shopping: { stage: "review", checkout: { id: "other" } } } });
      return new Response(null, { status: Number(fault) });
    };
    await assert.rejects(refreshShoppingStatus("conversation", "checkout", "", new AbortController().signal, request), error => {
      assert.ok(error instanceof Error);
      if (fault === "401") assert.equal((error as ShoppingRefreshError).status, 401);
      return true;
    });
    assert.equal(calls, 1);
  }
});
