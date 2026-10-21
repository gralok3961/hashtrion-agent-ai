import assert from "node:assert/strict";
import test from "node:test";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { MAX_MESSAGE_LENGTH, type ChatMessage } from "../src/lib/chat";
import type { DiscoveryReport } from "../src/lib/discovery-types";
import { runChat } from "../src/lib/server/chat-service";
import { discoverMerchants, verifyCandidates, type ModelResponse, type ResponsesClient } from "../src/lib/server/discovery";
import { catalogSearch } from "../src/lib/server/catalog";
import { providerCatalogSearch } from "../src/lib/server/catalog-provider";
import { CATALOG_CAPABILITY, createPlatformProfile } from "../src/lib/server/platform-profile";
import { parseUcpProfile } from "../src/lib/server/ucp-profile";
import { discoveryEnabled } from "../src/lib/server/usage-guard";

const SIGNAL = new AbortController().signal;
const VERSION = "2026-08-25";
const SHOPPING_REQUEST: ChatMessage[] = [{ role: "user", content: "손으로 만든 머그컵을 파는 가게를 찾아줘." }];

function profileBody() {
  return { ucp: {
    version: VERSION,
    services: { "dev.ucp.shopping": [{ version: VERSION, transport: "rest", endpoint: "https://api.merchant.example/ucp" }] },
    capabilities: { "dev.ucp.shopping.checkout": [{ version: VERSION, schema: `https://ucp.dev/${VERSION}/schemas/shopping/checkout.json` }] },
    payment_handlers: {},
  } };
}

function verifiedReport(): DiscoveryReport {
  return {
    status: "completed",
    sources: [{ url: "https://merchant.example/store", title: "merchant.example" }],
    merchants: [{
      domain: "merchant.example", profileUrl: "https://merchant.example/.well-known/ucp",
      status: "verified", profile: parseUcpProfile(profileBody()),
    }],
  };
}

function toolResponse(argumentsText = '{"query":"handmade mugs merchants"}'): ModelResponse {
  return { status: "completed", output_text: "", output: [{
    type: "function_call", name: "discover_merchants", arguments: argumentsText, call_id: "call_discovery",
  }] };
}

function textResponse(output_text: string): ModelResponse {
  return { status: "completed", output_text, output: [] };
}

function catalogCall(domain: string | null = "merchant.example"): ModelResponse {
  const call = toolResponse(JSON.stringify({ query: "research reports", merchant_domain: domain, merchant_name: null }));
  const item = call.output[0];
  if (item.type === "function_call") item.name = "search_catalog";
  return call;
}

function catalogProfile() {
  const body = profileBody();
  return { ucp: { ...body.ucp, capabilities: {
    [CATALOG_CAPABILITY]: [{ version: VERSION, schema: `https://ucp.dev/${VERSION}/schemas/shopping/catalog_search.json` }],
  } } };
}

function catalogBody() {
  return {
    ucp: { version: VERSION, capabilities: { [CATALOG_CAPABILITY]: [{ version: VERSION }] } },
    products: [{ id: "research-1", title: "Research Snapshot", description: { plain: "The merchant's report." },
      price_range: { min: { amount: 400, currency: "USD" }, max: { amount: 400, currency: "USD" } },
      variants: [{ id: "pdf", title: "PDF", description: { plain: "Digital edition" }, price: { amount: 400, currency: "USD" } }],
    }],
  };
}

function responsesFixture(results: (ModelResponse | Error)[]) {
  const calls: ResponseCreateParamsNonStreaming[] = [];
  const client: ResponsesClient = {
    create: async (params, options) => {
      assert.equal(options.signal, SIGNAL);
      calls.push(params);
      const result = results[calls.length - 1];
      assert.ok(result, "Unexpected additional model call");
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { calls, client };
}

test("natural-language shopping runs bounded discovery and returns parsed profile evidence to the final model", async () => {
  const search: ModelResponse = {
    status: "completed", output_text: "Found a possible merchant.", output: [{
      id: "search", type: "web_search_call", status: "completed", action: {
        type: "search", sources: [{ type: "url", url: "https://merchant.example/store" }],
      },
    }],
  };
  const model = responsesFixture([toolResponse(), search, textResponse('{"domains":["merchant.example"]}')]);
  const fetched: string[] = [];
  const result = await runChat(SHOPPING_REQUEST, {
    model: "configured-model", responses: model.client, signal: SIGNAL, discoveryEnabled: true,
    discover: (query, name, responses, signal) => discoverMerchants(query, name, responses, signal, {
      fetchProfile: async url => { fetched.push(url); return { url, body: profileBody() }; },
      validateDestination: async () => {},
    }),
  });
  assert.equal(model.calls.length, 3);
  assert.deepEqual(model.calls[0].input, SHOPPING_REQUEST);
  assert.equal(model.calls[0].parallel_tool_calls, false);
  assert.ok(model.calls[0].tools?.some(tool => tool.type === "function" && tool.name === "discover_merchants"));
  assert.equal(model.calls[1].input, "handmade mugs merchants");
  assert.deepEqual(fetched, ["https://merchant.example/.well-known/ucp"]);
  assert.deepEqual(result.discovery, verifiedReport());
  assert.ok(model.calls.every(call => call.model === "configured-model" && call.store === false));
  assert.deepEqual(model.calls[2].tools, []);
  const finalInput = model.calls[2].input;
  assert.ok(Array.isArray(finalInput));
  const output = finalInput.find(item => item.type === "function_call_output");
  assert.ok(output && output.type === "function_call_output");
  assert.equal(output.call_id, "call_discovery");
  assert.equal(typeof output.output, "string");
  assert.deepEqual(JSON.parse(output.output as string), verifiedReport());
});

test("ordinary conversation preserves message history, configured model, and one-call behavior", async () => {
  const history: ChatMessage[] = [
    { role: "user", content: "안녕" }, { role: "assistant", content: "안녕하세요." },
    { role: "user", content: "TypeScript가 뭐야?" },
  ];
  const model = responsesFixture([textResponse("TypeScript adds types to JavaScript.")]);
  const result = await runChat(history, {
    model: "configured-model", responses: model.client, signal: SIGNAL, discoveryEnabled: true,
    discover: async () => assert.fail("Ordinary chat must not trigger discovery"),
  });
  assert.equal(model.calls.length, 1);
  assert.deepEqual(model.calls[0].input, history);
  assert.equal(model.calls[0].model, "configured-model");
  assert.match(String(model.calls[0].instructions), /Respond in English\./);
  assert.deepEqual(result, { role: "assistant", content: "TypeScript adds types to JavaScript." });
});

test("follow-up history retains merchant identity while technical details stay in diagnostics", async () => {
  const discoveryModel = responsesFixture([toolResponse(), textResponse('{"domains":["merchant.example"]}')]);
  const reply = await runChat(SHOPPING_REQUEST, {
    model: "configured-model", responses: discoveryModel.client, signal: SIGNAL, discoveryEnabled: true,
    discover: async () => verifiedReport(),
  });
  const followup = responsesFixture([textResponse("The previously checked merchant was merchant.example.")]);
  await runChat([...SHOPPING_REQUEST, reply, { role: "user", content: "방금 찾은 상점은?" }], {
    model: "configured-model", responses: followup.client, signal: SIGNAL, discoveryEnabled: true,
    discover: async () => assert.fail("Reading previous results must not require another discovery"),
  });
  const input = followup.calls[0].input;
  assert.ok(Array.isArray(input));
  assert.deepEqual(input[1], { role: "assistant", content: reply.content });
  assert.match(reply.content, /merchant\.example: connection verified/);
  assert.equal(reply.content.includes(VERSION), false);
  assert.equal(reply.content.includes("https://api.merchant.example/ucp"), false);
  assert.equal(reply.content.includes("dev.ucp.shopping.checkout"), false);
  assert.deepEqual(reply.discovery, verifiedReport());
  assert.equal(input.some(item => item.type === "function_call_output"), false);
});

test("large verified profiles cannot exceed the assistant message limit or lose the full evidence cards", async () => {
  const report = verifiedReport();
  const merchant = report.merchants[0];
  assert.equal(merchant.status, "verified");
  if (merchant.status !== "verified") assert.fail("Expected verified fixture");
  merchant.profile.restEndpoints = Array.from({ length: 8 }, (_, index) => ({
    service: "dev.ucp.shopping", version: VERSION, url: `https://api.merchant.example/${index}/${"a".repeat(1_900)}`,
  }));
  const model = responsesFixture([toolResponse(), textResponse('{"domains":["merchant.example"]}')]);
  const result = await runChat(SHOPPING_REQUEST, {
    model: "configured-model", responses: model.client, signal: SIGNAL, discoveryEnabled: true,
    discover: async () => report,
  });
  assert.ok(result.content.length <= MAX_MESSAGE_LENGTH);
  assert.equal(result.content.includes("https://api.merchant.example"), false);
  assert.deepEqual(result.discovery, report);
  assert.equal(merchant.profile.restEndpoints.length, 8);
});

test("disabled discovery does not trigger Web Search or merchant HTTP requests", async () => {
  const model = responsesFixture([toolResponse()]);
  const result = await runChat(SHOPPING_REQUEST, {
    model: "configured-model", responses: model.client, signal: SIGNAL,
    discoveryEnabled: discoveryEnabled({ NODE_ENV: "production", MERCHANT_DISCOVERY_ENABLED: "false" }),
    discover: async () => assert.fail("Explicitly disabled discovery must remain blocked"),
  });
  assert.equal(model.calls.length, 1);
  assert.deepEqual(result.discovery, { status: "disabled", sources: [], merchants: [] });
  assert.ok(model.calls.every(call => !call.tools?.some(tool => tool.type === "web_search")));
});

test("failed search and missing search sources remain explicit without final-model fallback", async () => {
  for (const status of ["search_failed", "no_sources"] as const) {
    const model = responsesFixture([toolResponse()]);
    const result = await runChat(SHOPPING_REQUEST, {
      model: "configured-model", responses: model.client, signal: SIGNAL, discoveryEnabled: true,
      discover: async () => ({ status, sources: [], merchants: [] }),
    });
    assert.equal(model.calls.length, 1);
    assert.deepEqual(result.discovery, { status, sources: [], merchants: [] });
    assert.ok(result.content.length > 0);
  }
});

test("final model failure still returns the verified evidence", async () => {
  const model = responsesFixture([toolResponse(), new Error("private upstream diagnostic")]);
  const result = await runChat(SHOPPING_REQUEST, {
    model: "configured-model", responses: model.client, signal: SIGNAL, discoveryEnabled: true,
    discover: async () => verifiedReport(),
  });
  assert.deepEqual(result.discovery, verifiedReport());
  assert.equal(result.content.includes("private upstream diagnostic"), false);
  assert.equal(model.calls.length, 2);
});

test("fabricated final model success prose cannot become user-visible discovery evidence", async () => {
  const model = responsesFixture([
    toolResponse(), textResponse("Verified invented.example with UCP fake-version and https://invented.example/checkout."),
  ]);
  const result = await runChat(SHOPPING_REQUEST, {
    model: "configured-model", responses: model.client, signal: SIGNAL, discoveryEnabled: true,
    discover: async () => verifiedReport(),
  });
  assert.equal(result.content.includes("invented.example"), false);
  assert.equal(result.content.includes("fake-version"), false);
  assert.deepEqual(result.discovery, verifiedReport());
});

test("a final model's unsupported domain cannot alter or add verified merchants", async () => {
  const model = responsesFixture([toolResponse(), textResponse('{"domains":["invented.example","merchant.example"]}')]);
  const result = await runChat(SHOPPING_REQUEST, {
    model: "configured-model", responses: model.client, signal: SIGNAL, discoveryEnabled: true,
    discover: async () => verifiedReport(),
  });
  assert.equal(result.content.includes("invented.example"), false);
  assert.deepEqual(result.discovery, verifiedReport());
});

test("empty relevance ranking explicitly says no matching merchant was confirmed while retaining checked evidence", async () => {
  const model = responsesFixture([toolResponse(), textResponse('{"domains":[]}')]);
  const result = await runChat([{ role: "user", content: "Find a shop matching my request" }], {
    model: "configured-model", responses: model.client, signal: SIGNAL, discoveryEnabled: true,
    discover: async () => verifiedReport(),
  });
  assert.match(result.content, /No merchant matching the request was confirmed/);
  assert.deepEqual(result.discovery, verifiedReport());
});

test("invalid or multiple function calls fail before any discovery work", async () => {
  const wrongName = toolResponse();
  const firstCall = wrongName.output[0];
  if (firstCall.type !== "function_call") assert.fail("Expected function fixture");
  firstCall.name = "execute_payment";
  const duplicate = toolResponse();
  duplicate.output.push(...duplicate.output);
  const incomplete = toolResponse();
  incomplete.status = "incomplete";
  for (const response of [
    toolResponse("not json"), toolResponse("null"), toolResponse('{"query":""}'),
    toolResponse('{"query":12}'), toolResponse(JSON.stringify({ query: "x".repeat(501) })),
    wrongName, duplicate, incomplete,
  ]) {
    const model = responsesFixture([response]);
    await assert.rejects(runChat(SHOPPING_REQUEST, {
      model: "configured-model", responses: model.client, signal: SIGNAL, discoveryEnabled: true,
      discover: async () => assert.fail("Malformed tool request must not execute discovery"),
    }), /invalid_tool_call/);
    assert.equal(model.calls.length, 1);
  }
});

test("completed responses with empty text and incomplete ordinary replies are rejected", async () => {
  const incomplete = textResponse("partial reply");
  incomplete.status = "incomplete";
  for (const response of [textResponse(" "), incomplete, textResponse("x".repeat(12_001))]) {
    const model = responsesFixture([response]);
    await assert.rejects(runChat([{ role: "user", content: "Hello" }], {
      model: "configured-model", responses: model.client, signal: SIGNAL, discoveryEnabled: true,
    }), /incomplete_reply/);
  }
});

test("natural product request verifies a user-specified merchant and returns real parsed catalog data to GPT", async () => {
  const model = responsesFixture([catalogCall(), textResponse('{"product_ids":["research-1"]}')]);
  let profileCalls = 0, postCalls = 0;
  const result = await runChat([{ role: "user", content: "Find research reports from merchant.example." }], {
    model: "configured-model", responses: model.client, signal: SIGNAL, discoveryEnabled: true,
    discover: async () => assert.fail("Explicit host is not replaced by web search"),
    verify: (sources, signal) => verifyCandidates(sources, signal, {
      fetchProfile: async url => { profileCalls++; assert.equal(url, "https://merchant.example/.well-known/ucp"); return { url, body: catalogProfile() }; },
      validateDestination: async () => {},
    }),
    catalog: (merchant, query, options) => catalogSearch(merchant, query, { ...options, platformProfileUrl: "https://agent.example/.well-known/ucp" }, {
      fetchProfile: async url => ({ url, body: createPlatformProfile() }),
      post: async (url, body, headers) => {
        postCalls++;
        assert.equal(url, "https://api.merchant.example/ucp/catalog/search");
        assert.deepEqual(body, { query: "research reports", pagination: { limit: 10 } });
        assert.equal(headers["UCP-Agent"], 'profile="https://agent.example/.well-known/ucp"');
        assert.match(headers["Request-Id"], /^[a-f0-9-]{36}$/);
        return { url, status: 200, body: catalogBody() };
      },
    }),
  });
  assert.equal(profileCalls, 1); assert.equal(postCalls, 1); assert.equal(model.calls.length, 2);
  assert.equal(result.catalog?.status, "completed");
  assert.equal(result.catalog.products[0].variants[0].price.amount, 400);
  assert.equal(result.content, "Explore these products from merchant.example.");
  assert.equal(result.content.includes("Research Snapshot"), false);
  assert.equal(result.catalog.products[0].title, "Research Snapshot");
  assert.equal(result.content.includes("dev.ucp"), false);
  assert.equal(result.content.includes(VERSION), false);
  assert.equal(result.content.includes("https://api."), false);
  const input = model.calls[1].input;
  assert.ok(Array.isArray(input));
  const tool = input.find(item => item.type === "function_call_output");
  assert.ok(tool && tool.type === "function_call_output" && typeof tool.output === "string");
  const evidence = JSON.parse(tool.output);
  assert.equal(evidence.catalog.products[0].variants[0].price.amount, 400);
  assert.equal(evidence.discovery.sources[0].kind, "user_provided");
});

test("a general merchant-tool call routes to the registered provider without choosing a random web merchant", async () => {
  const model = responsesFixture([catalogCall(null), textResponse("Invented Product costs USD $0.01.")]);
  let searches = 0;
  const result = await runChat([{ role: "user", content: "Find research reports" }], {
    model: "configured-model", responses: model.client, signal: SIGNAL, discoveryEnabled: true,
    discover: async () => assert.fail("General products use the catalog provider, not arbitrary merchant discovery"),
    catalog: async () => assert.fail("No individual merchant was requested"),
    providerCatalog: (provider, query, options) => providerCatalogSearch(provider, query, { ...options, platformProfileUrl: "https://agent.example/.well-known/ucp" }, {
      fetchProfile: async url => ({ url, body: createPlatformProfile() }),
      mcp: async (endpoint, profile, search) => {
        searches++;
        assert.equal(endpoint, "https://catalog.shopify.com/api/ucp/mcp");
        assert.equal(profile, "https://agent.example/.well-known/ucp");
        assert.equal(search.query, "research reports");
        return catalogBody();
      },
    }),
  });
  assert.equal(searches, 1);
  assert.equal(result.catalog?.provider, "shopify-global");
  assert.equal(result.catalog.products[0].variants[0].price.amount, 400);
  assert.equal(result.catalog.products[0].variants[0].price.currency, "USD");
  assert.equal(result.discovery, undefined);
  assert.equal(result.content, "Explore these products from Shopify stores.");
  assert.equal(result.content.includes("Invented Product"), false);
  assert.equal(result.content.includes("$0.01"), false);
});

test("a specified MCP storefront uses its verified advertised transport, never Global Catalog", async () => {
  const model = responsesFixture([catalogCall("shop.example"), textResponse('{"product_ids":["research-1"]}')]);
  const report = verifiedReport();
  const mcpBody = catalogProfile();
  mcpBody.ucp.services["dev.ucp.shopping"][0].transport = "mcp";
  mcpBody.ucp.services["dev.ucp.shopping"][0].endpoint = "https://catalog.shop.example/ucp/mcp";
  report.sources.push({ url: "https://shop.example/", title: "shop.example" });
  report.merchants.push({
    domain: "shop.example", profileUrl: "https://shop.example/.well-known/ucp", status: "verified", profile: parseUcpProfile(mcpBody),
  });
  let catalogs = 0;
  const result = await runChat([{ role: "user", content: "Find research reports from shop.example" }], {
    model: "configured-model", responses: model.client, signal: SIGNAL, discoveryEnabled: true,
    discover: async () => assert.fail("Exact merchant domains do not use web search"),
    verify: async () => report.merchants.filter(m => m.domain === "shop.example"),
    providerCatalog: async () => assert.fail("No Global Catalog fallback"),
    catalog: (merchant, query, options) => {
      catalogs++;
      assert.equal(merchant.domain, "shop.example");
      assert.deepEqual(merchant.profile.restEndpoints, []);
      return catalogSearch(merchant, query, { ...options, platformProfileUrl: "https://agent.example/.well-known/ucp" }, {
        fetchProfile: async url => ({ url, body: createPlatformProfile() }),
        post: async () => assert.fail("MCP shopping must not invoke REST"),
        mcp: async (endpoint, profile, search) => {
          assert.equal(endpoint, "https://catalog.shop.example/ucp/mcp");
          assert.equal(profile, "https://agent.example/.well-known/ucp");
          assert.deepEqual(search, { query: "research reports", pagination: { limit: 10 } });
          return catalogBody();
        },
      });
    },
  });
  assert.equal(catalogs, 1);
  assert.equal(result.catalog?.status, "completed");
  assert.equal(result.catalog.merchantDomain, "shop.example");
  assert.equal(result.catalog.diagnostics.transport, "mcp");
  assert.equal(result.catalog.products[0].variants[0].price.amount, 400);
  assert.equal(result.content, "Explore these products from shop.example.");
  assert.equal(result.content.includes("mcp"), false);
  assert.deepEqual(model.calls[0].tools?.map(tool => tool.type === "function" ? tool.name : tool.type).sort(), ["discover_merchants", "search_catalog"]);
  assert.deepEqual(model.calls[1].tools, []);
});

test("missing public platform deployment is an explicit blocker, never a fake successful catalog", async () => {
  const model = responsesFixture([catalogCall(), textResponse('{"product_ids":[]}')]);
  const report = verifiedReport();
  if (report.merchants[0].status !== "verified") assert.fail();
  report.merchants[0].profile = parseUcpProfile(catalogProfile());
  const result = await runChat([{ role: "user", content: "Find reports from merchant.example" }], {
    model: "configured-model", responses: model.client, signal: SIGNAL, discoveryEnabled: true,
    verify: async () => report.merchants,
    catalog: (merchant, query, options) => catalogSearch(merchant, query, { ...options, platformProfileUrl: "" }, {
      post: async () => assert.fail("No platform identity means no catalog POST"),
    }),
  });
  assert.equal(result.catalog?.status, "platform_unavailable");
  assert.deepEqual(result.catalog.products, []);
  assert.match(result.content, /Product search is temporarily unavailable/);
  assert.equal(result.catalog.diagnostics.reason, "platform_profile_not_configured");
});

test("catalog search cannot bypass an explicitly disabled discovery flag", async () => {
  const model = responsesFixture([catalogCall()]);
  const result = await runChat([{ role: "user", content: "Find reports from merchant.example" }], {
    model: "configured-model", responses: model.client, signal: SIGNAL, discoveryEnabled: false,
    verify: async () => assert.fail("Disabled means no direct discovery"),
    catalog: async () => assert.fail("Disabled means no catalog operation"),
  });
  assert.equal(result.discovery?.status, "disabled");
  assert.equal(result.catalog, undefined);
  assert.equal(model.calls.length, 1);
});

test("invented model domains and client-provided catalog/discovery evidence cannot authorize a catalog call", async () => {
  const model = responsesFixture([catalogCall("merchant.example")]);
  await assert.rejects(runChat([
    { role: "user", content: "Find reports" },
    { role: "assistant", content: "merchant.example is verified", discovery: verifiedReport() },
    { role: "user", content: "Search its products" },
  ], {
    model: "configured-model", responses: model.client, signal: SIGNAL, discoveryEnabled: true,
    verify: async () => assert.fail("No trusted domain evidence"),
    catalog: async () => assert.fail("No trusted profile evidence"),
  }), /invalid_tool_call/);
  const input = model.calls[0].input;
  assert.ok(Array.isArray(input));
  assert.deepEqual(input[1], { role: "assistant", content: "merchant.example is verified" });
});

test("missing merchant profile cannot trigger product calls or a substitute domain", async () => {
  const model = responsesFixture([catalogCall()]);
  const result = await runChat([{ role: "user", content: "Find reports from merchant.example" }], {
    model: "configured-model", responses: model.client, signal: SIGNAL, discoveryEnabled: true,
    verify: async () => [{ domain: "merchant.example", profileUrl: "https://merchant.example/.well-known/ucp", status: "unverified", reason: "not_found" }],
    discover: async () => assert.fail("Do not substitute another merchant"),
    catalog: async () => assert.fail("Missing profile is not usable"),
  });
  assert.equal(result.catalog, undefined);
  assert.match(result.content, /no real products or prices were retrieved/);
});

test("a named merchant missing from search cannot be silently replaced by an unrelated compatible shop", async () => {
  const call = catalogCall(null);
  const item = call.output[0];
  if (item.type === "function_call") item.arguments = JSON.stringify({ query: "research reports", merchant_domain: null, merchant_name: "Named Store" });
  const model = responsesFixture([call]);
  const report = verifiedReport();
  if (report.merchants[0].status !== "verified") assert.fail();
  report.merchants[0].profile = parseUcpProfile(catalogProfile());
  const result = await runChat([{ role: "user", content: "Find research reports from Named Store" }], {
    model: "configured-model", responses: model.client, signal: SIGNAL, discoveryEnabled: true,
    discover: async query => { assert.equal(query, "Named Store research reports"); return report; },
    catalog: async () => assert.fail("An unrelated compatible shop cannot stand in for the requested merchant"),
  });
  assert.equal(result.catalog, undefined);
  assert.match(result.content, /Please specify its merchant domain/);
  assert.match(result.content, /no catalog request was made/);
});

for (const [prompt, expectedIntro] of [
  ["Show me products from merchant.example.", "Explore these products from merchant.example."],
  ["merchant.example의 상품을 보여줘.", "Explore these products from merchant.example."],
]) {
  test(`keyword-free browsing uses official filters with a concise introduction: ${prompt}`, async () => {
    const call = catalogCall();
    const item = call.output[0];
    if (item.type !== "function_call") assert.fail();
    item.arguments = JSON.stringify({ mode: "browse", query: "", merchant_domain: "merchant.example", merchant_name: null });
    const model = responsesFixture([call, textResponse('{"product_ids":["research-1"]}')]);
    const report = verifiedReport();
    if (report.merchants[0].status !== "verified") assert.fail();
    report.merchants[0].profile = parseUcpProfile(catalogProfile());
    const result = await runChat([{ role: "user", content: prompt }], {
      model: "configured-model", responses: model.client, signal: SIGNAL, discoveryEnabled: true,
      continuationSecret: "synthetic-pagination-signing-secret-for-tests-only",
      verify: async () => report.merchants,
      catalog: (merchant, query, options) => catalogSearch(merchant, query, { ...options, platformProfileUrl: "https://agent.example/.well-known/ucp" }, {
        fetchProfile: async url => ({ url, body: createPlatformProfile() }),
        post: async (url, body) => {
          assert.deepEqual(body, { filters: { price: { min: 0 } }, pagination: { limit: 10 } });
          return { url, status: 200, body: { ...catalogBody(), pagination: { has_next_page: true, cursor: "real-next-cursor", total_count: 2 } } };
        },
      }),
    });
    assert.equal(result.content, expectedIntro);
    assert.equal(result.catalog?.query, "");
    assert.equal(result.catalog.products[0].variants[0].price.amount, 400);
    assert.deepEqual(result.catalog.filters, { price: { min: 0 } });
    assert.ok(result.catalog.continuation);
    assert.equal(JSON.stringify(model.calls).includes(result.catalog.continuation), false, "Continuation never becomes model input");
    assert.equal(result.content.includes("Research Snapshot"), false, "Product facts belong only in cards");
  });
}

test("browsing never invents keywords and asks for a merchant when none is supplied", async () => {
  const call = catalogCall(null);
  const item = call.output[0];
  if (item.type !== "function_call") assert.fail();
  item.arguments = JSON.stringify({ mode: "browse", query: "", merchant_domain: null, merchant_name: null });
  const model = responsesFixture([call]);
  const result = await runChat([{ role: "user", content: "Show me all products" }], {
    model: "configured-model", responses: model.client, signal: SIGNAL, discoveryEnabled: true,
    discover: async () => assert.fail("No invented broad search"), catalog: async () => assert.fail("No invented merchant"),
  });
  assert.match(result.content, /Which merchant/);
  assert.equal(result.catalog, undefined);
});

for (const transport of ["rest", "mcp"] as const) {
  test(`a source-backed unambiguous named merchant uses its advertised ${transport} transport`, async () => {
    const call = catalogCall(null);
    const item = call.output[0];
    if (item.type !== "function_call") assert.fail();
    item.arguments = JSON.stringify({ mode: "search", query: "research reports", merchant_domain: null, merchant_name: "Named Store" });
    const model = responsesFixture([call, textResponse('{"product_ids":["research-1"]}')]);
    const report = verifiedReport();
    const profile = catalogProfile();
    const endpoint = `https://catalog.named-store.example/${transport}`;
    profile.ucp.services["dev.ucp.shopping"][0] = { version: VERSION, transport, endpoint };
    report.sources.push({ url: "https://named-store.example/", title: "named-store.example" });
    report.merchants.push({ domain: "named-store.example", profileUrl: "https://named-store.example/.well-known/ucp", status: "verified", profile: parseUcpProfile(profile) });
    let operations = 0;
    const result = await runChat([{ role: "user", content: "Find research reports from Named Store" }], {
      model: "configured-model", responses: model.client, signal: SIGNAL, discoveryEnabled: true,
      discover: async query => { assert.equal(query, "Named Store research reports"); return report; },
      providerCatalog: async () => assert.fail("A requested merchant cannot be replaced by Global Catalog"),
      catalog: (merchant, query, options) => {
        assert.equal(merchant.domain, "named-store.example");
        return catalogSearch(merchant, query, { ...options, platformProfileUrl: "https://agent.example/.well-known/ucp" }, {
          fetchProfile: async url => ({ url, body: createPlatformProfile() }),
          post: async url => {
            assert.equal(transport, "rest"); assert.equal(url, `${endpoint}/catalog/search`); operations++;
            return { url, status: 200, body: catalogBody() };
          },
          mcp: async url => {
            assert.equal(transport, "mcp"); assert.equal(url, endpoint); operations++;
            return catalogBody();
          },
        });
      },
    });
    assert.equal(operations, 1);
    assert.equal(result.catalog?.diagnostics.transport, transport);
    assert.equal(result.catalog?.merchantDomain, "named-store.example");
    assert.equal(result.catalog?.provider, undefined);
    assert.equal(result.catalog?.products[0].variants[0].price.amount, 400);
  });
}

test("an unavailable named merchant never falls through to a verified unrelated merchant or provider", async () => {
  const call = catalogCall(null);
  const item = call.output[0];
  if (item.type !== "function_call") assert.fail();
  item.arguments = JSON.stringify({ mode: "search", query: "reports", merchant_domain: null, merchant_name: "Named Store" });
  const report = verifiedReport();
  report.sources.push({ url: "https://named-store.example/", title: "named-store.example" });
  report.merchants.push({ domain: "named-store.example", profileUrl: "https://named-store.example/.well-known/ucp", status: "unverified", reason: "not_found" });
  const result = await runChat([{ role: "user", content: "Find reports from Named Store" }], {
    model: "configured-model", responses: responsesFixture([call]).client, signal: SIGNAL, discoveryEnabled: true,
    discover: async () => report,
    catalog: async () => assert.fail("No substitution"), providerCatalog: async () => assert.fail("No provider fallback"),
  });
  assert.equal(result.catalog, undefined);
  assert.match(result.content, /no real products or prices/);
});

test("merchant follow-ups reverify a user-supplied historical host instead of using the provider", async () => {
  const model = responsesFixture([catalogCall()]);
  let verified = 0;
  const result = await runChat([
    { role: "user", content: "Show reports from merchant.example" },
    { role: "assistant", content: "Previous reports." },
    { role: "user", content: "Show that shop's newest research reports" },
  ], {
    model: "configured-model", responses: model.client, signal: SIGNAL, discoveryEnabled: true,
    verify: async sources => { verified++; assert.equal(sources[0].url, "https://merchant.example/"); return []; },
    discover: async () => assert.fail("No guessed domain"), providerCatalog: async () => assert.fail("No provider fallback"),
  });
  assert.equal(verified, 1);
  assert.equal(result.catalog, undefined);
});
