import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  discoverMerchants, extractSearchSources, MAX_CANDIDATES, verifyCandidates,
  type ModelResponse, type ResponsesClient, type ResponseParameters,
} from "../src/lib/server/discovery";
import { createSafeHttpClient, SafeFetchError } from "../src/lib/server/safe-http";
import { isDiscoveryReport } from "../src/lib/discovery-types";

const VERSION = "2026-08-25";
const SIGNAL = new AbortController().signal;

function profile(endpoint = "https://api.merchant.example/ucp") {
  return {
    ucp: {
      version: VERSION,
      services: { "dev.ucp.shopping": [{ version: VERSION, transport: "rest", endpoint }] },
      capabilities: { "dev.ucp.shopping.checkout": [{
        version: VERSION,
        schema: `https://ucp.dev/${VERSION}/schemas/shopping/checkout.json`,
      }] },
      payment_handlers: {},
    },
  };
}

function searched(urls: string[], text = "Search results."): ModelResponse {
  return {
    status: "completed",
    output_text: text,
    output: [{
      id: "ws_test", type: "web_search_call", status: "completed",
      action: { type: "search", sources: urls.map(url => ({ type: "url", url })) },
    }],
  };
}

function modelReturning(response: ModelResponse | Error) {
  const calls: ResponseParameters[] = [];
  const client: ResponsesClient = {
    create: async (params) => {
      calls.push(params);
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return { client, calls };
}

// Exercise the actual safe HTTPS fetcher and UCP parser using a fake DNS resolver
// and HTTPS socket response. This makes no network or OpenAI requests.
function httpsFixture(options: { status?: number; body?: unknown; privateEndpoint?: boolean } = {}) {
  const requests: RequestOptions[] = [];
  const resolved: string[] = [];
  const safe = createSafeHttpClient({
    resolve: async hostname => {
      resolved.push(hostname);
      return [{ address: options.privateEndpoint && hostname.startsWith("api.") ? "10.0.0.1" : "93.184.216.34", family: 4 }];
    },
    request: (requestOptions, callback) => {
      requests.push(requestOptions);
      const request = new EventEmitter() as ClientRequest;
      request.end = (() => {
        queueMicrotask(() => {
          const response = Object.assign(new PassThrough(), {
            statusCode: options.status ?? 200,
            headers: { "content-type": "application/json" },
          }) as unknown as IncomingMessage;
          callback(response);
          response.emit("data", Buffer.from(JSON.stringify(options.body ?? profile())));
          response.emit("end");
        });
        return request;
      }) as ClientRequest["end"];
      request.destroy = (() => request) as ClientRequest["destroy"];
      return request;
    },
  });
  return { requests, resolved, dependencies: { fetchProfile: safe.fetchPublicJson, validateDestination: safe.assertPublicDestination } };
}

test("verified metadata comes from a mocked HTTPS profile body, not model claims", async () => {
  const model = modelReturning(searched(["https://merchant.example/store"], "The UCP version is invented-version."));
  const http = httpsFixture();
  const report = await discoverMerchants("Find a shop selling handmade mugs", "test-model", model.client, SIGNAL, http.dependencies);
  assert.equal(report.status, "completed");
  assert.equal(report.merchants.length, 1);
  const merchant = report.merchants[0];
  assert.equal(merchant.status, "verified");
  if (merchant.status !== "verified") assert.fail("Expected a verified HTTPS profile");
  assert.equal(merchant.domain, "merchant.example");
  assert.equal(merchant.profileUrl, "https://merchant.example/.well-known/ucp");
  assert.equal(merchant.profile.version, VERSION);
  assert.deepEqual(merchant.profile.capabilities, [{ name: "dev.ucp.shopping.checkout", version: VERSION }]);
  assert.equal(merchant.profile.restEndpoints[0].url, "https://api.merchant.example/ucp");
  assert.equal(http.requests.length, 1);
  assert.equal(http.requests[0].protocol, "https:");
  assert.equal(http.requests[0].path, "/.well-known/ucp");
  assert.deepEqual(http.resolved, ["merchant.example", "api.merchant.example"]);
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0].model, "test-model");
  assert.equal(model.calls[0].input, "Find a shop selling handmade mugs");
  assert.deepEqual(model.calls[0].tools, [{ type: "web_search", search_context_size: "low" }]);
  assert.equal(model.calls[0].tool_choice, "required");
  assert.deepEqual(model.calls[0].include, ["web_search_call.action.sources"]);
  assert.ok("max_tool_calls" in model.calls[0]);
  assert.equal(model.calls[0].max_tool_calls, 1);
  assert.equal(model.calls[0].store, false);
  assert.equal(isDiscoveryReport(report), true);
});

test("missing HTTPS profiles stay unverified and retain their source", async () => {
  const http = httpsFixture({ status: 404 });
  const { client } = modelReturning(searched(["https://merchant.example/store"]));
  const report = await discoverMerchants("Find a ceramics shop", "test-model", client, SIGNAL, http.dependencies);
  assert.equal(report.status, "completed");
  assert.deepEqual(report.merchants, [{
    domain: "merchant.example", profileUrl: "https://merchant.example/.well-known/ucp",
    status: "unverified", reason: "not_found",
  }]);
  assert.equal(report.sources[0].url, "https://merchant.example/store");
});

test("MCP-only discovery verifies its actual profile and DNS without invoking tools", async () => {
  const body = profile("https://api.merchant.example/mcp");
  body.ucp.services["dev.ucp.shopping"][0].transport = "mcp";
  const http = httpsFixture({ body });
  const { client } = modelReturning(searched(["https://merchant.example/store"]));
  const report = await discoverMerchants("Find a merchant", "test-model", client, SIGNAL, http.dependencies);
  const merchant = report.merchants[0];
  if (merchant.status !== "verified") assert.fail("Expected a verified MCP profile");
  assert.deepEqual(merchant.profile.restEndpoints, []);
  assert.deepEqual(merchant.profile.services, [{
    name: "dev.ucp.shopping", version: VERSION, transport: "mcp", endpoint: "https://api.merchant.example/mcp",
  }]);
  assert.deepEqual(http.resolved, ["merchant.example", "api.merchant.example"]);
  assert.equal(http.requests.length, 1, "Discovery fetches the profile, never a tool or catalog operation");
  assert.equal(isDiscoveryReport(JSON.parse(JSON.stringify(report))), true, "MCP results survive frontend and session validation");
  const missingEndpoint = structuredClone(report);
  if (missingEndpoint.merchants[0].status !== "verified") assert.fail("Expected a verified fixture");
  delete missingEndpoint.merchants[0].profile.services[0].endpoint;
  assert.equal(isDiscoveryReport(missingEndpoint), false);
  const unsafeEndpoint = structuredClone(report);
  if (unsafeEndpoint.merchants[0].status !== "verified") assert.fail("Expected a verified fixture");
  unsafeEndpoint.merchants[0].profile.services[0].endpoint = "http://api.merchant.example/mcp";
  assert.equal(isDiscoveryReport(unsafeEndpoint), false);
});

test("malformed profile, unsupported transports, and unsafe REST or MCP DNS cannot be verified", async () => {
  const unsupported = profile();
  unsupported.ucp.services["dev.ucp.shopping"][0].transport = "a2a";
  const mcp = profile();
  mcp.ucp.services["dev.ucp.shopping"][0].transport = "mcp";
  for (const [http, reason] of [
    [httpsFixture({ body: { ucp: { version: "made-up" } } }), "invalid_profile"],
    [httpsFixture({ body: unsupported }), "no_supported_transport"],
    [httpsFixture({ privateEndpoint: true }), "unsafe_destination"],
    [httpsFixture({ body: mcp, privateEndpoint: true }), "unsafe_destination"],
  ] as const) {
    const result = await verifyCandidates([{ url: "https://merchant.example/", title: "shop" }], SIGNAL, http.dependencies);
    assert.equal(result[0].status, "unverified");
    if (result[0].status !== "unverified") assert.fail("Must not verify an invalid or unsafe profile");
    assert.equal(result[0].reason, reason);
    assert.equal(http.requests.length, 1, "No advertised service operation may be requested");
  }
});

test("a public REST binding cannot hide an MCP binding resolving to a private address", async () => {
  const body = profile("https://merchant.example/ucp");
  body.ucp.services["dev.ucp.shopping"].push({
    version: VERSION, transport: "mcp", endpoint: "https://api.merchant.example/mcp",
  });
  const http = httpsFixture({ body, privateEndpoint: true });
  const result = await verifyCandidates([{ url: "https://merchant.example/", title: "shop" }], SIGNAL, http.dependencies);
  assert.deepEqual(result, [{
    domain: "merchant.example", profileUrl: "https://merchant.example/.well-known/ucp",
    status: "unverified", reason: "unsafe_destination",
  }]);
  assert.equal(http.requests.length, 1);
});

test("new unsupported transport reports and older no_rest session reports remain readable", () => {
  for (const reason of ["no_rest", "no_supported_transport"]) {
    assert.equal(isDiscoveryReport({
      status: "completed", sources: [], merchants: [{
        domain: "merchant.example", profileUrl: "https://merchant.example/.well-known/ucp",
        status: "unverified", reason,
      }],
    }), true);
  }
});

test("profile adapters cannot silently redirect to another origin", async () => {
  const result = await verifyCandidates([{ url: "https://merchant.example/", title: "shop" }], SIGNAL, {
    fetchProfile: async () => ({ body: profile(), url: "https://other.example/.well-known/ucp" }),
    validateDestination: async () => assert.fail("Redirected profile must not reach endpoint validation"),
  });
  assert.equal(result[0].status, "unverified");
  if (result[0].status !== "unverified") assert.fail("Must not verify a redirect");
  assert.equal(result[0].reason, "unsafe_destination");
});

test("invented text, citation annotations, function arguments, and opened URLs are not search sources", () => {
  const response = searched(["https://merchant.example/catalog#top", "https://merchant.example/catalog"], "Verified https://invented.example");
  response.output.push(
    { id: "open", type: "web_search_call", status: "completed", action: { type: "open_page", url: "https://opened.example" } },
    { type: "function_call", name: "discover_merchants", arguments: '{"query":"https://argument.example"}', call_id: "call_example" },
    { id: "message", type: "message", role: "assistant", status: "completed", content: [{
      type: "output_text", text: "https://annotated.example", annotations: [{
        type: "url_citation", start_index: 0, end_index: 25, title: "unsupported citation", url: "https://annotated.example",
      }], logprobs: [],
    }] },
  );
  assert.deepEqual(extractSearchSources(response), [{ url: "https://merchant.example/catalog", title: "merchant.example" }]);
});

test("unsafe search source URLs are discarded before any profile request", async () => {
  const sources = extractSearchSources(searched([
    "http://merchant.example", "https://127.0.0.1/", "https://169.254.169.254/metadata",
    "https://user:password@merchant.example/", "https://[::1]/", "https://service.internal/",
  ]));
  assert.deepEqual(sources, []);
  assert.deepEqual(await verifyCandidates(sources, SIGNAL, {
    fetchProfile: async () => assert.fail("Unsafe candidates must not be fetched"),
  }), []);
});

test("source and candidate counts are bounded, domains deduplicate across paths", async () => {
  const sources = extractSearchSources(searched([
    "https://merchant0.example/a", "https://merchant0.example/b",
    ...Array.from({ length: 15 }, (_, i) => `https://merchant${i + 1}.example/store`),
  ]));
  assert.equal(sources.length, 10);
  const fetched: string[] = [];
  const results = await verifyCandidates(sources, SIGNAL, {
    fetchProfile: async url => {
      fetched.push(url);
      throw new SafeFetchError("not_found");
    },
  });
  assert.equal(results.length, MAX_CANDIDATES);
  assert.equal(fetched.length, 5);
  assert.equal(new Set(fetched).size, 5);
  assert.ok(fetched.every(url => new URL(url).pathname === "/.well-known/ucp"));
});

test("web search API failures and failed or incomplete search actions cannot fall back to invented domains", async () => {
  const failed = searched(["https://merchant.example/"]);
  const searchCall = failed.output[0];
  if (searchCall.type !== "web_search_call") assert.fail("Expected search fixture");
  searchCall.status = "failed";
  const incomplete = searched(["https://merchant.example/"]);
  incomplete.status = "incomplete";
  const incompleteCall = incomplete.output[0];
  if (incompleteCall.type !== "web_search_call") assert.fail("Expected search fixture");
  incompleteCall.status = "incomplete";
  for (const response of [new Error("private upstream diagnostic"), failed, incomplete]) {
    const { client } = modelReturning(response);
    const report = await discoverMerchants("Find the named shop", "test-model", client, SIGNAL, {
      fetchProfile: async () => assert.fail("Search failure must not fetch fallback profiles"),
    });
    assert.deepEqual(report, { status: "search_failed", sources: [], merchants: [] });
  }
});

test("completed search evidence survives an unfinished extra search without trusting unfinished sources", async () => {
  for (const overallStatus of ["completed", "incomplete"] as const) {
    const response = searched(["https://merchant.example/store"], "Invented https://text-only.example");
    response.status = overallStatus;
    response.output.push({
      id: "unfinished", type: "web_search_call", status: "searching", action: {
        type: "search", sources: [{ type: "url", url: "https://unfinished.example/store" }],
      },
    });
    const { client } = modelReturning(response);
    const http = httpsFixture();
    const report = await discoverMerchants("Find a named shop", "test-model", client, SIGNAL, http.dependencies);
    assert.equal(report.status, "completed");
    assert.equal(report.searchIncomplete, true);
    assert.deepEqual(report.sources, [{ url: "https://merchant.example/store", title: "merchant.example" }]);
    assert.equal(report.merchants.length, 1);
    assert.equal(report.merchants[0].status, "verified");
    assert.equal(report.merchants[0].domain, "merchant.example");
    assert.equal(http.requests.length, 1);
    assert.equal(http.requests[0].hostname, "merchant.example");
    assert.equal(JSON.stringify(report).includes("unfinished.example"), false);
    assert.equal(JSON.stringify(report).includes("text-only.example"), false);
  }
});

test("an unfinished search cannot rescue completed search sources that are all unsafe", async () => {
  const response = searched(["https://127.0.0.1/", "http://merchant.example/"]);
  response.output.push({
    id: "unfinished", type: "web_search_call", status: "searching", action: {
      type: "search", sources: [{ type: "url", url: "https://unfinished.example/store" }],
    },
  });
  const { client } = modelReturning(response);
  const report = await discoverMerchants("Find a named shop", "test-model", client, SIGNAL, {
    fetchProfile: async () => assert.fail("No completed, safe source exists to fetch"),
  });
  assert.deepEqual(report, { status: "search_failed", sources: [], merchants: [] });
});

test("a model's unsupported website claim produces no_sources without fallback", async () => {
  const { client } = modelReturning({ status: "completed", output: [], output_text: "I found https://invented.example" });
  const report = await discoverMerchants("Find a named store", "test-model", client, SIGNAL, {
    fetchProfile: async () => assert.fail("Output prose is not retrieval evidence"),
  });
  assert.deepEqual(report, { status: "no_sources", sources: [], merchants: [] });
});

test("excessive combined REST and MCP destinations do not trigger unbounded DNS work", async () => {
  const body = profile();
  body.ucp.services["dev.ucp.shopping"] = Array.from({ length: 9 }, (_, i) => ({
    version: VERSION, transport: i % 2 ? "mcp" : "rest", endpoint: `https://api${i}.merchant.example/ucp`,
  }));
  const result = await verifyCandidates([{ url: "https://merchant.example/", title: "shop" }], SIGNAL, {
    fetchProfile: async url => ({ url, body }),
    validateDestination: async () => assert.fail("Too many endpoints must fail before DNS validation"),
  });
  assert.equal(result[0].status, "unverified");
  if (result[0].status !== "unverified") assert.fail("Must not verify an excessive profile");
  assert.equal(result[0].reason, "invalid_profile");
});
