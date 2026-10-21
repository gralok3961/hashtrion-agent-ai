import assert from "node:assert/strict";
import test from "node:test";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import type { CatalogReport } from "../src/lib/catalog-types";
import { runChat } from "../src/lib/server/chat-service";
import { SHOPIFY_GLOBAL_PROVIDER } from "../src/lib/server/catalog-provider";
import type { ModelResponse, ResponsesClient } from "../src/lib/server/discovery";

const signal = new AbortController().signal;
const prompt = "Find running shoes from Shopify stores and show the products with images, prices, and seller links.";
const productUrl = "https://retailer.example/products/shoe?variant=42&utm_source=shopify";
function report(): CatalogReport {
  return {
    status: "completed", provider: "shopify-global", merchantDomain: "catalog.shopify.com", query: "running shoes",
    products: [{ id: "shoe", title: "Merchant shoe", url: productUrl,
      images: [{ url: "https://cdn.example/shoe.jpg" }],
      variants: [{ id: "size-9", title: "9", url: productUrl, images: [], price: { amount: 4200, currency: "USD" } }],
    }], messages: [], pagination: { hasNextPage: true, cursor: "genuine-next-page" },
    diagnostics: { profileUrl: "https://agent.example/.well-known/ucp", transport: "mcp" },
  };
}
function model(name = "search_global_catalog", args: unknown = { query: "running shoes" }) {
  const calls: ResponseCreateParamsNonStreaming[] = [];
  const client: ResponsesClient = { create: async (params): Promise<ModelResponse> => {
    calls.push(params);
    return calls.length === 1 ? { status: "completed", output_text: "", output: [{ type: "function_call", name, call_id: "global-call", arguments: JSON.stringify(args) }] } :
      { status: "completed", output: [], output_text: '{"product_ids":["invented-product"]}' };
  } };
  return { calls, client };
}
const noNetwork = {
  discover: async () => assert.fail("Global provider must not guess a merchant through web search"),
  verify: async () => assert.fail("A configured provider is not a verified individual merchant"),
  catalog: async () => assert.fail("A provider must not replace a storefront endpoint"),
};

test("GPT-selected registered Global Catalog returns real structured evidence, not fabricated model products", async () => {
  const responses = model();
  let searches = 0;
  const result = await runChat([{ role: "user", content: prompt }], {
    model: "configured-model", responses: responses.client, signal, discoveryEnabled: true,
    continuationSecret: "synthetic-independent-pagination-signing-key",
    platformProfileUrl: "https://agent.example/.well-known/ucp", ...noNetwork,
    providerCatalog: async (provider, query, options) => {
      searches++;
      assert.equal(provider, SHOPIFY_GLOBAL_PROVIDER);
      assert.equal(query, "running shoes");
      assert.equal(options.platformProfileUrl, "https://agent.example/.well-known/ucp");
      return report();
    },
  });
  assert.equal(searches, 1);
  assert.equal(responses.calls.length, 2);
  assert.ok(responses.calls[0].tools?.some(t => t.type === "function" && t.name === "search_global_catalog"));
  assert.ok(responses.calls.every(c => c.store === false && c.model === "configured-model"));
  assert.deepEqual(result.catalog?.products, report().products);
  assert.equal(result.catalog?.provider, "shopify-global");
  assert.ok(result.catalog?.continuation);
  assert.equal(result.discovery, undefined);
  assert.equal(result.content, "Explore these products from Shopify stores.");
  assert.ok(!result.content.includes("ucp") && !result.content.includes("4200"));
  const input = responses.calls[1].input;
  assert.ok(Array.isArray(input));
  const output = input.find(i => i.type === "function_call_output");
  assert.ok(output?.type === "function_call_output" && typeof output.output === "string");
  assert.equal(JSON.parse(output.output).catalog.products[0].url, productUrl);
});

test("Global Catalog uses English introductions for non-English requests and keeps authoritative empty results", async () => {
  const responses = model();
  const result = await runChat([{ role: "user", content: "Shopify 상점에서 러닝화를 찾아줘" }], {
    model: "configured-model", responses: responses.client, signal, discoveryEnabled: true,
    ...noNetwork, providerCatalog: async () => report(),
  });
  assert.equal(result.content, "Explore these products from Shopify stores.");
  const empty = await runChat([{ role: "user", content: prompt }], {
    model: "configured-model", responses: model().client, signal, discoveryEnabled: true,
    ...noNetwork,
    providerCatalog: async () => ({ ...report(), products: [], pagination: { hasNextPage: false } }),
  });
  assert.equal(empty.catalog?.products.length, 0);
  assert.equal(empty.catalog?.continuation, undefined);
  assert.match(empty.content, /No products/);
});

test("disabled discovery and explicit merchant domains cannot invoke Global Catalog", async () => {
  for (const [content, enabled] of [[prompt, false], ["Find shoes from retailer.example on Shopify stores", true]] as const) {
    const responses = model();
    await assert.rejects(() => runChat([{ role: "user", content }], {
      model: "configured-model", responses: responses.client, signal, discoveryEnabled: enabled,
      ...noNetwork,
      providerCatalog: async () => assert.fail("No provider operation is authorized"),
    }), /invalid_tool_call/);
    assert.ok(!responses.calls[0].tools?.some(t => t.type === "function" && t.name === "search_global_catalog"));
  }
});

test("Global Catalog tool cannot accept arbitrary endpoint or extra arguments", async () => {
  for (const args of [{ query: "running shoes", endpoint: "https://evil.example" }, { query: "" }, { query: "x".repeat(501) }]) {
    await assert.rejects(() => runChat([{ role: "user", content: prompt }], {
      model: "configured-model", responses: model("search_global_catalog", args).client, signal,
      discoveryEnabled: true, ...noNetwork,
      providerCatalog: async () => assert.fail("Invalid arguments must not trigger networking"),
    }), /invalid_tool_call/);
  }
});

for (const content of ["Find running shoes", "운동화를 찾아줘", "Find adidas running shoes", "Find sportswear across merchants"]) {
  test(`general shopping offers automatic provider routing without Shopify keywords: ${content}`, async () => {
    const responses = model();
    const result = await runChat([{ role: "user", content }], {
      model: "configured-model", responses: responses.client, signal, discoveryEnabled: true,
      ...noNetwork, providerCatalog: async provider => {
        assert.equal(provider, SHOPIFY_GLOBAL_PROVIDER);
        return report();
      },
    });
    assert.equal(result.catalog?.provider, "shopify-global");
    assert.equal(responses.calls[0].tool_choice, "auto");
    assert.equal(responses.calls[0].parallel_tool_calls, false);
    assert.ok(responses.calls[0].tools?.some(t => t.type === "function" && t.name === "search_catalog"));
    assert.ok(responses.calls[0].tools?.some(t => t.type === "function" && t.name === "search_global_catalog"));
    assert.equal(responses.calls.length, 2);
  });
}

test("a new general request after a merchant-specific conversation can use the provider", async () => {
  const result = await runChat([
    { role: "user", content: "Find reports from retailer.example" },
    { role: "assistant", content: "A previous catalog result." },
    { role: "user", content: "Now find running shoes across different shops instead." },
  ], {
    model: "configured-model", responses: model().client, signal, discoveryEnabled: true,
    ...noNetwork, providerCatalog: async () => report(),
  });
  assert.equal(result.catalog?.provider, "shopify-global");
});

test("no active provider never silently falls back to an arbitrary merchant", async () => {
  const args = { mode: "search", query: "running shoes", merchant_domain: null, merchant_name: null };
  const responses = model("search_catalog", args);
  const result = await runChat([{ role: "user", content: "Find running shoes" }], {
    model: "configured-model", responses: responses.client, signal, discoveryEnabled: true, provider: null,
    ...noNetwork, providerCatalog: async () => assert.fail("No provider is enabled"),
  });
  assert.equal(result.catalog, undefined);
  assert.match(result.content, /unavailable/);
  assert.ok(!responses.calls[0].tools?.some(t => t.type === "function" && t.name === "search_global_catalog"));
});
