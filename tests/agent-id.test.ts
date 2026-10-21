import assert from "node:assert/strict";
import test from "node:test";
import { isAgentId, maskAgentId } from "../src/lib/agent-id";
import { runChat } from "../src/lib/server/chat-service";
import type { ResponseParameters } from "../src/lib/server/discovery";

test("Agent ID accepts the exact prefix and 26 RFC 4648 Base32 characters", () => {
  for (const value of [
    "agt_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    `agt_${"234567".repeat(4)}23`,
    `agt_${"A".repeat(25)}7`,
    `agt_${"I".repeat(13)}${"O".repeat(13)}`,
  ]) assert.equal(isAgentId(value), true);
});

test("Agent ID rejects nonstrings, wrong length, wrong alphabet and normalization candidates", () => {
  const valid = "agt_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const value of [
    undefined, null, 1234, {}, [], true,
    "", "agt_", `agt_${"A".repeat(25)}`, `agt_${"A".repeat(27)}`,
    valid.toUpperCase(), valid.toLowerCase(), valid.replace("agt_", "id__"),
    ` ${valid}`, `${valid} `, `${valid}\n`, `agt_${"A".repeat(25)}\n`,
    ...["0", "1", "8", "9", "-", "_", "é", "Ａ", " "].map(char => `agt_${"A".repeat(25)}${char}`),
  ]) assert.equal(isAgentId(value), false);
});

test("Agent ID display reveals only its prefix, first six and last five payload characters", () => {
  const value = "agt_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  assert.equal(maskAgentId(value), "agt_ABCDEF...VWXYZ");
  assert.ok(!maskAgentId(value).includes("GHIJKLMNOPQRSTU"));
});

test("request Agent ID is not forwarded to catalog transport or model tool-result ranking", async () => {
  const agentId = "agt_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const calls: ResponseParameters[] = [];
  let catalogCalls = 0;
  const result = await runChat([{ role: "user", content: "Find running shoes." }], {
    agentId, model: "synthetic-agent-id-model", discoveryEnabled: true, signal: new AbortController().signal,
    responses: { create: async parameters => {
      calls.push(parameters);
      return calls.length === 1 ? {
        status: "completed", output_text: "", output: [{
          type: "function_call", name: "search_global_catalog", call_id: "agent-context-search", arguments: '{"query":"running shoes"}',
        }],
      } : { status: "completed", output_text: '{"product_ids":[]}', output: [] };
    } },
    discover: async () => assert.fail("Global search must not discover unrelated merchants"),
    verify: async () => assert.fail("This test must not fetch merchant profiles"),
    catalog: async () => assert.fail("This test must not call a merchant catalog"),
    providerCatalog: async (provider, query, options) => {
      catalogCalls++;
      assert.ok(!("agentId" in options));
      assert.ok(!JSON.stringify({ provider, query, options }).includes(agentId));
      return {
        provider: provider.id, status: "completed", merchantDomain: "catalog.shopify.com", query,
        products: [], messages: [], pagination: { hasNextPage: false },
        diagnostics: { profileUrl: "https://agent.example/.well-known/ucp", transport: "mcp" },
      };
    },
    continuationSecret: "synthetic-agent-id-continuation-key-not-real",
  });
  assert.equal(catalogCalls, 1);
  assert.equal(calls.length, 2);
  assert.equal(result.catalog?.status, "completed");
  assert.ok(!JSON.stringify({ calls, result }).includes(agentId));
  assert.ok(!JSON.stringify(calls).includes("agentId"));
});
