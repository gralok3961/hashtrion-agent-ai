import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { httpbis } from "http-message-signatures";
import { createUcpSigner, type SigningRequest } from "../src/lib/server/ucp-signature";
import { EventEmitter } from "node:events";
import type { IncomingHttpHeaders, ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import type { LookupAddress } from "node:dns";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createSafeHttpClient, safePublicUrl, SafeFetchError } from "../src/lib/server/safe-http";
import { checkoutRequest } from "../src/lib/server/checkout";
import { assertCredentialEndpointIdentity } from "../src/lib/server/payment-handler-discovery";
import { catalogSearch } from "../src/lib/server/catalog";
import { parseUcpProfile } from "../src/lib/server/ucp-profile";
import { CATALOG_CAPABILITY, CATALOG_VERSION, createPlatformProfile } from "../src/lib/server/platform-profile";

const PROFILE_URL = "https://merchant.example/.well-known/ucp";
const PUBLIC_ADDRESS = { address: "93.184.216.34", family: 4 };
const CATALOG_URL = "https://api.merchant.example/ucp/catalog/search";
const UCP_HEADERS = {
  "Request-Id": "ba64e7e2-811b-4cb8-92d9-9c8c23b1f180",
  "UCP-Agent": 'profile="https://agent.example/.well-known/ucp"',
};

function fixture(options: {
  sign?: (request: SigningRequest) => Promise<Record<string, string>>;
  addresses?: LookupAddress[];
  resolve?: (hostname: string) => Promise<LookupAddress[]>;
  status?: number;
  headers?: IncomingHttpHeaders;
  chunks?: Buffer[];
  requestError?: Error;
  hangResponse?: boolean;
  hangBody?: boolean;
  timeoutMs?: number;
  productionTimeouts?: boolean;
  responseDelayMs?: number;
  maxBytes?: number;
  maxRequestBytes?: number;
} = {}) {
  const requests: RequestOptions[] = [];
  const sentBodies: (Buffer | undefined)[] = [];
  const resolved: string[] = [];
  let destroyed = false;
  const client = createSafeHttpClient({
    sign: options.sign,
    resolve: async (hostname) => {
      resolved.push(hostname);
      return options.resolve ? options.resolve(hostname) : options.addresses ?? [PUBLIC_ADDRESS];
    },
    request: (requestOptions, callback) => {
      requests.push(requestOptions);
      const request = new EventEmitter() as ClientRequest;
      request.end = ((body?: Buffer) => {
        sentBodies.push(body);
        const deliver = () => {
          if (options.requestError) { request.emit("error", options.requestError); return; }
          if (options.hangResponse) return;
          const response = Object.assign(new PassThrough(), {
            statusCode: options.status ?? 200,
            headers: { "content-type": "application/json", ...options.headers },
          }) as unknown as IncomingMessage;
          callback(response);
          for (const chunk of options.chunks ?? [Buffer.from('{"ucp":{"version":"2026-01-11"}}')]) response.emit("data", chunk);
          if (!options.hangBody) response.emit("end");
        };
        if (options.responseDelayMs) setTimeout(deliver, options.responseDelayMs);
        else queueMicrotask(deliver);
        return request;
      }) as ClientRequest["end"];
      request.destroy = (() => { destroyed = true; return request; }) as ClientRequest["destroy"];
      return request;
    },
    timeoutMs: options.productionTimeouts ? undefined : options.timeoutMs ?? 100,
    completeCheckoutTimeoutMs: options.productionTimeouts ? undefined : options.timeoutMs ?? 100,
    maxBytes: options.maxBytes,
    maxRequestBytes: options.maxRequestBytes,
  });
  return { ...client, requests, sentBodies, resolved, wasDestroyed: () => destroyed };
}

test("accepts public HTTPS domains and public literal addresses", () => {
  for (const raw of [PROFILE_URL, "https://93.184.216.34/ucp", "https://[2606:4700:4700::1111]/ucp"]) {
    assert.equal(safePublicUrl(raw).protocol, "https:");
  }
});

test("rejects unsafe URL syntax and special-use IPv4/IPv6 destinations", () => {
  const unsafe = [
    "http://merchant.example/", "ftp://merchant.example/", "https://merchant.example:444/",
    "https://user:password@merchant.example/", "https://@merchant.example/", "https://merchant.example/#",
    "https://merchant.example/#section", "https://merchant.example/\\path", " https://merchant.example/",
    "https://merchant.example/\u0000", "https://localhost/", "https://service.internal/",
    "https://example.local/", "https://merchant.example./", "https://merchant..example/",
    "https://127.0.0.1/", "https://127.1/", "https://0x7f000001/", "https://2130706433/",
    "https://0.0.0.0/", "https://10.1.2.3/", "https://172.16.1.1/", "https://192.168.1.1/",
    "https://169.254.169.254/", "https://100.100.100.200/", "https://168.63.129.16/",
    "https://192.0.2.1/", "https://198.18.0.1/", "https://224.0.0.1/", "https://240.0.0.1/",
    "https://[::]/", "https://[::1]/", "https://[::ffff:127.0.0.1]/", "https://[::ffff:8.8.8.8]/",
    "https://[fe80::1]/", "https://[fc00::1]/", "https://[ff02::1]/", "https://[64:ff9b::0808:0808]/",
    "https://[2001:db8::1]/", "https://[2001::1]/", "https://[2002:0808:0808::1]/",
    "https://[3fff::1]/", "https://[4000::1]/",
  ];
  for (const raw of unsafe) assert.throws(() => safePublicUrl(raw), { code: "unsafe_url" }, raw);
});

test("fetches JSON with original hostname TLS validation and pinned public DNS", async () => {
  const client = fixture();
  const result = await client.fetchPublicJson(PROFILE_URL);
  assert.deepEqual(result, { body: { ucp: { version: "2026-01-11" } }, url: PROFILE_URL });
  assert.deepEqual(client.resolved, ["merchant.example"]);
  assert.equal(client.requests.length, 1);
  const options = client.requests[0];
  assert.equal(options.hostname, "merchant.example");
  assert.equal(options.servername, "merchant.example");
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.agent, false);
  assert.equal(options.port, 443);
  assert.equal(options.method, "GET");
  assert.equal(options.path, "/.well-known/ucp");
  assert.deepEqual(options.headers, { Accept: "application/json", "Accept-Encoding": "identity" });
  options.lookup!("merchant.example", { all: true }, (error, addresses) => {
    assert.equal(error, null);
    assert.deepEqual(addresses, [PUBLIC_ADDRESS]);
  });
  options.lookup!("merchant.example", {}, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, PUBLIC_ADDRESS.address);
    assert.equal(family, 4);
  });
});

test("DNS rebinding cannot trigger another resolution during HTTPS connection", async () => {
  let calls = 0;
  const client = fixture({ resolve: async () => ++calls === 1 ? [PUBLIC_ADDRESS] : [{ address: "127.0.0.1", family: 4 }] });
  await client.fetchPublicJson(PROFILE_URL);
  for (let i = 0; i < 3; i++) {
    client.requests[0].lookup!("merchant.example", {}, (_error, address) => assert.equal(address, PUBLIC_ADDRESS.address));
  }
  assert.equal(calls, 1);
});

test("a single unsafe DNS answer rejects the entire destination without fetching", async () => {
  for (const address of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "168.63.129.16", "::ffff:127.0.0.1", "2001:db8::1"]) {
    const family = address.includes(":") ? 6 : 4;
    const client = fixture({ addresses: [PUBLIC_ADDRESS, { address, family }] });
    await assert.rejects(client.fetchPublicJson(PROFILE_URL), { code: "unsafe_url" });
    assert.equal(client.requests.length, 0);
  }
});

test("rejects empty DNS answers and inconsistent address families", async () => {
  for (const addresses of [[], [{ address: "127.0.0.1", family: 6 }], [{ address: "not-an-ip", family: 4 }]]) {
    await assert.rejects(fixture({ addresses }).fetchPublicJson(PROFILE_URL), { code: "unsafe_url" });
  }
});

test("validates REST endpoint DNS without making an HTTP request", async () => {
  const client = fixture();
  await client.assertPublicDestination(new URL("https://api.merchant.example/api"));
  assert.deepEqual(client.resolved, ["api.merchant.example"]);
  assert.equal(client.requests.length, 0);
  await assert.rejects(fixture({ addresses: [{ address: "10.0.0.2", family: 4 }] }).assertPublicDestination(new URL(PROFILE_URL)), { code: "unsafe_url" });
});

test("rejects all redirects without following their Location", async () => {
  for (const location of ["http://127.0.0.1/private", "https://other.example/.well-known/ucp", "/new-profile"]) {
    const client = fixture({ status: 302, headers: { location } });
    await assert.rejects(client.fetchPublicJson(PROFILE_URL), { code: "unsafe_url" });
    assert.equal(client.requests.length, 1);
    assert.equal(client.wasDestroyed(), true);
  }
});

test("returns safe error codes for missing or failed profiles", async () => {
  for (const status of [404, 410]) await assert.rejects(fixture({ status }).fetchPublicJson(PROFILE_URL), { code: "not_found" });
  for (const status of [204, 401, 429, 500]) await assert.rejects(fixture({ status }).fetchPublicJson(PROFILE_URL), { code: "http_error" });
});

test("refuses compression and non-JSON content types", async () => {
  for (const headers of [{ "content-encoding": "gzip" }, { "content-type": "text/html" }]) {
    await assert.rejects(fixture({ headers }).fetchPublicJson(PROFILE_URL), { code: "http_error" });
  }
  await fixture({ headers: { "content-type": "application/ucp+json; charset=utf-8" } }).fetchPublicJson(PROFILE_URL);
});

test("enforces both declared and streamed response-size limits", async () => {
  await assert.rejects(fixture({ headers: { "content-length": "131073" } }).fetchPublicJson(PROFILE_URL), { code: "too_large" });
  await assert.rejects(fixture({ chunks: [Buffer.alloc(128 * 1024), Buffer.from("!")] }).fetchPublicJson(PROFILE_URL), { code: "too_large" });
  await assert.rejects(fixture({ headers: { "content-length": "invalid" } }).fetchPublicJson(PROFILE_URL), { code: "http_error" });
});

test("refuses malformed JSON and invalid UTF-8", async () => {
  for (const chunk of [Buffer.from("not json"), Buffer.from('{"truncated":'), Buffer.from([0x22, 0xff, 0x22])]) {
    await assert.rejects(fixture({ chunks: [chunk] }).fetchPublicJson(PROFILE_URL), { code: "invalid_json" });
  }
});

test("the total deadline covers DNS resolution", async () => {
  const client = fixture({ resolve: () => new Promise(() => {}), timeoutMs: 10 });
  await assert.rejects(client.fetchPublicJson(PROFILE_URL), { code: "timeout" });
  assert.equal(client.requests.length, 0);
});

test("the total deadline covers connection and body wait", async () => {
  const client = fixture({ hangResponse: true, timeoutMs: 10 });
  await assert.rejects(client.fetchPublicJson(PROFILE_URL), { code: "timeout" });
  assert.equal(client.wasDestroyed(), true);
});

test("request cancellation stops pending I/O", async () => {
  const controller = new AbortController();
  const client = fixture({ hangResponse: true });
  const pending = client.fetchPublicJson(PROFILE_URL, controller.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { code: "network_error" });
  assert.equal(client.wasDestroyed(), true);
});

test("already-cancelled requests do not resolve or fetch", async () => {
  const client = fixture();
  await assert.rejects(client.fetchPublicJson(PROFILE_URL, AbortSignal.abort()), { code: "network_error" });
  assert.equal(client.requests.length, 0);
  assert.equal(client.resolved.length, 0);
});

test("network errors never reveal raw exception contents", async () => {
  const client = fixture({ requestError: new Error("private infrastructure diagnostic") });
  await assert.rejects(client.fetchPublicJson(PROFILE_URL), (error: unknown) => {
    assert.ok(error instanceof SafeFetchError);
    assert.equal(error.code, "network_error");
    assert.equal(error.message.includes("private infrastructure"), false);
    return true;
  });
});

test("POST sends bounded UTF-8 JSON and only UCP identity headers with pinned DNS and TLS", async () => {
  let resolutions = 0;
  const client = fixture({ resolve: async () => ++resolutions === 1 ? [PUBLIC_ADDRESS] : [{ address: "127.0.0.1", family: 4 }] });
  const body = { query: "한글 report", limit: 10 };
  const runtimeHeaders = { ...UCP_HEADERS, Authorization: "must-not-forward", Cookie: "must-not-forward" };
  const result = await client.postPublicJson(CATALOG_URL, body, runtimeHeaders);
  assert.equal(result.status, 200);
  assert.equal(result.url, CATALOG_URL);
  assert.deepEqual(result.body, { ucp: { version: "2026-01-11" } });
  assert.equal(client.requests.length, 1);
  const options = client.requests[0];
  assert.equal(options.hostname, "api.merchant.example");
  assert.equal(options.servername, "api.merchant.example");
  assert.equal(options.path, "/ucp/catalog/search");
  assert.equal(options.method, "POST");
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.agent, false);
  assert.deepEqual(options.headers, {
    Accept: "application/json", "Accept-Encoding": "identity", "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(JSON.stringify(body)), ...UCP_HEADERS,
    "Idempotency-Key": (options.headers as Record<string, string>)["Idempotency-Key"],
  });
  assert.match(String((options.headers as Record<string, unknown>)["Idempotency-Key"]), /^[0-9a-f-]{36}$/);
  assert.deepEqual(client.sentBodies, [Buffer.from(JSON.stringify(body))]);
  options.lookup!("api.merchant.example", {}, (_error, address) => assert.equal(address, PUBLIC_ADDRESS.address));
  assert.equal(resolutions, 1);
});

test("POST preserves JSON HTTP errors for catalog-level validation", async () => {
  const errorBody = { errors: [{ code: "unsupported_version", message: "Public protocol error" }] };
  for (const status of [400, 401, 404, 409, 422, 429, 500, 503]) {
    const client = fixture({ status, chunks: [Buffer.from(JSON.stringify(errorBody))] });
    assert.deepEqual(await client.postPublicJson(CATALOG_URL, { query: "report" }, UCP_HEADERS), {
      status, body: errorBody, url: CATALOG_URL,
    });
  }
});

test("POST refuses unsafe DNS, private destinations, and all redirects without forwarding", async () => {
  for (const url of ["http://api.merchant.example/catalog/search", "https://169.254.169.254/catalog/search"]) {
    const client = fixture();
    await assert.rejects(client.postPublicJson(url, {}, UCP_HEADERS), { code: "unsafe_url" });
    assert.equal(client.requests.length, 0);
  }
  const unsafeDns = fixture({ addresses: [PUBLIC_ADDRESS, { address: "10.0.0.1", family: 4 }] });
  await assert.rejects(unsafeDns.postPublicJson(CATALOG_URL, {}, UCP_HEADERS), { code: "unsafe_url" });
  assert.equal(unsafeDns.requests.length, 0);
  for (const status of [301, 302, 303, 307, 308]) {
    const client = fixture({ status, headers: { location: "https://other.example/catalog/search" } });
    await assert.rejects(client.postPublicJson(CATALOG_URL, {}, UCP_HEADERS), { code: "unsafe_url" });
    assert.equal(client.requests.length, 1);
    assert.equal(client.wasDestroyed(), true);
  }
});

test("POST rejects oversized and non-serializable request bodies before network access", async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  for (const body of [undefined, BigInt(1), circular]) {
    const client = fixture();
    await assert.rejects(client.postPublicJson(CATALOG_URL, body, UCP_HEADERS), { code: "invalid_request" });
    assert.equal(client.resolved.length, 0);
    assert.equal(client.requests.length, 0);
  }
  const client = fixture();
  await assert.rejects(client.postPublicJson(CATALOG_URL, { query: "가".repeat(12_000) }, UCP_HEADERS), { code: "too_large" });
  assert.equal(client.resolved.length, 0);
  assert.equal(client.requests.length, 0);
});

test("POST refuses header injection and non-public platform identities", async () => {
  for (const headers of [
    { ...UCP_HEADERS, "Request-Id": "bad\r\nAuthorization:secret" },
    { ...UCP_HEADERS, "Request-Id": "" },
    { ...UCP_HEADERS, "UCP-Agent": 'profile="https://agent.example/.well-known/ucp"\r\nCookie:secret' },
    { ...UCP_HEADERS, "UCP-Agent": 'profile="https://agent.example/.well-known/ucp?secret=value"' },
  ]) {
    const client = fixture();
    await assert.rejects(client.postPublicJson(CATALOG_URL, {}, headers), { code: "invalid_request" });
    assert.equal(client.resolved.length, 0);
  }
  for (const profile of ["http://agent.example/ucp", "https://127.0.0.1/ucp", "https://user:secret@agent.example/ucp"]) {
    const client = fixture();
    await assert.rejects(client.postPublicJson(CATALOG_URL, {}, { ...UCP_HEADERS, "UCP-Agent": `profile="${profile}"` }), { code: "unsafe_url" });
    assert.equal(client.requests.length, 0);
  }
});

test("POST bounds error bodies and rejects compressed, non-JSON, or malformed responses", async () => {
  for (const status of [200, 400, 500]) {
    await assert.rejects(fixture({ status, headers: { "content-length": "131073" } }).postPublicJson(CATALOG_URL, {}, UCP_HEADERS), { code: "too_large" });
    await assert.rejects(fixture({ status, chunks: [Buffer.alloc(128 * 1024), Buffer.from("!")] }).postPublicJson(CATALOG_URL, {}, UCP_HEADERS), { code: "too_large" });
    await assert.rejects(fixture({ status, chunks: [Buffer.from("malformed")] }).postPublicJson(CATALOG_URL, {}, UCP_HEADERS), { code: "invalid_json" });
    for (const headers of [{ "content-type": "text/html" }, { "content-encoding": "gzip" }]) {
      await assert.rejects(fixture({ status, headers }).postPublicJson(CATALOG_URL, {}, UCP_HEADERS), { code: "http_error" });
    }
  }
});

test("POST preserves deadline and cancellation controls", async () => {
  const client = fixture({ hangResponse: true, timeoutMs: 10 });
  await assert.rejects(client.postPublicJson(CATALOG_URL, {}, UCP_HEADERS), { code: "timeout" });
  assert.equal(client.wasDestroyed(), true);
  const cancelled = fixture();
  await assert.rejects(cancelled.postPublicJson(CATALOG_URL, {}, UCP_HEADERS, AbortSignal.abort()), { code: "network_error" });
  assert.equal(cancelled.resolved.length, 0);
  assert.equal(cancelled.requests.length, 0);
});

const MCP_URL = "https://api.merchant.example/api/ucp/mcp";
const AGENT_PROFILE_URL = "https://agent.example/.well-known/ucp";
const MCP_BODY = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } });
const MCP_RESPONSE = { jsonrpc: "2.0", id: 0, result: { protocolVersion: "2025-06-18", capabilities: {} } };

function mcpFixture(options: Parameters<typeof fixture>[0] = {}) {
  const client = fixture({ chunks: [Buffer.from(JSON.stringify(MCP_RESPONSE))], ...options });
  return { ...client, mcpFetch: client.createMcpFetch(MCP_URL, AGENT_PROFILE_URL, new AbortController().signal) };
}

test("MCP fetch pins DNS and TLS while forwarding only bounded protocol and public identity headers", async () => {
  let calls = 0;
  const client = mcpFixture({
    resolve: async () => ++calls === 1 ? [PUBLIC_ADDRESS] : [{ address: "127.0.0.1", family: 4 }],
    headers: { "mcp-session-id": "session-1", "set-cookie": ["must-not-forward"], "www-authenticate": "must-not-forward", location: "https://other.example/" },
  });
  const result = await client.mcpFetch(new URL(MCP_URL), {
    method: "POST", body: MCP_BODY,
    headers: { Authorization: "must-not-forward", Cookie: "must-not-forward", Host: "127.0.0.1", "UCP-Agent": "must-not-forward", "Request-Id": "must-not-forward", "Mcp-Session-Id": "session-0", "Mcp-Protocol-Version": "2025-06-18" },
  });
  assert.deepEqual(await result.json(), MCP_RESPONSE);
  assert.deepEqual([...result.headers], [["content-type", "application/json"], ["mcp-session-id", "session-1"]]);
  const options = client.requests[0];
  assert.equal(options.method, "POST");
  assert.equal(options.hostname, "api.merchant.example");
  assert.equal(options.servername, "api.merchant.example");
  assert.equal(options.path, "/api/ucp/mcp");
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.agent, false);
  assert.equal(options.port, 443);
  const headers = options.headers as Record<string, string | number>;
  assert.match(String(headers["Request-Id"]), /^[a-f0-9-]{36}$/);
  assert.deepEqual({ ...headers, "Request-Id": "generated" }, {
    Accept: "application/json, text/event-stream", "Accept-Encoding": "identity", "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(MCP_BODY), "Request-Id": "generated", "UCP-Agent": `profile="${AGENT_PROFILE_URL}"`,
    "Mcp-Session-Id": "session-0", "Mcp-Protocol-Version": "2025-06-18",
  });
  assert.deepEqual(client.sentBodies, [Buffer.from(MCP_BODY)]);
  for (let i = 0; i < 3; i++) options.lookup!("api.merchant.example", {}, (_error, address) => assert.equal(address, PUBLIC_ADDRESS.address));
  assert.equal(calls, 1);
});

test("MCP fetch rejects unsafe or changed endpoints and private DNS without requesting", async () => {
  for (const endpoint of ["http://merchant.example/mcp", "https://127.0.0.1/mcp", `${MCP_URL}?token=hidden`]) {
    assert.throws(() => fixture().createMcpFetch(endpoint, AGENT_PROFILE_URL, new AbortController().signal), { code: "unsafe_url" });
  }
  for (const identity of ["http://agent.example/ucp", "https://169.254.169.254/ucp", `${AGENT_PROFILE_URL}?token=hidden`]) {
    assert.throws(() => fixture().createMcpFetch(MCP_URL, identity, new AbortController().signal), { code: "unsafe_url" });
  }
  for (const target of ["https://other.example/mcp", `${MCP_URL}/extra`, `${MCP_URL}?x=1`, "https://169.254.169.254/"]) {
    const client = mcpFixture();
    await assert.rejects(client.mcpFetch(target, { method: "POST", body: MCP_BODY }), { code: "unsafe_url" });
    assert.equal(client.requests.length, 0);
    assert.equal(client.resolved.length, 0);
  }
  const client = mcpFixture({ addresses: [PUBLIC_ADDRESS, { address: "10.0.0.1", family: 4 }] });
  await assert.rejects(client.mcpFetch(MCP_URL, { method: "POST", body: MCP_BODY }), { code: "unsafe_url" });
  assert.equal(client.requests.length, 0);
});

test("MCP optional GET and DELETE stay local and unsupported methods never reach the network", async () => {
  const client = mcpFixture();
  for (const method of ["GET", "DELETE"]) {
    const response = await client.mcpFetch(MCP_URL, { method });
    assert.equal(response.status, 405);
  }
  await assert.rejects(client.mcpFetch(MCP_URL, { method: "PUT", body: MCP_BODY }), { code: "invalid_request" });
  assert.equal(client.requests.length, 0);
  assert.equal(client.resolved.length, 0);
});

test("MCP fetch never follows redirects or initiates OAuth after an unauthorized response", async () => {
  for (const status of [301, 302, 303, 307, 308, 401, 403, 404, 429, 500]) {
    const client = mcpFixture({ status, headers: { location: "https://127.0.0.1/", "www-authenticate": 'Bearer resource_metadata="https://internal.example/oauth"' } });
    await assert.rejects(client.mcpFetch(MCP_URL, { method: "POST", body: MCP_BODY }), { code: status < 400 ? "unsafe_url" : "http_error" });
    assert.equal(client.requests.length, 1);
    assert.equal(client.wasDestroyed(), true);
  }
});

test("MCP initialized notifications accept empty 202 responses without waiting for a body", async () => {
  const client = mcpFixture({ status: 202, headers: { "content-type": undefined }, chunks: [], hangBody: true });
  const response = await client.mcpFetch(MCP_URL, {
    method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(response.status, 202);
  assert.equal(await response.text(), "");
  assert.equal(client.wasDestroyed(), true);
  await assert.rejects(mcpFixture({ status: 202 }).mcpFetch(MCP_URL, { method: "POST", body: MCP_BODY }), { code: "http_error" });
});

test("MCP initialized alone normalizes HTTP 200 JSON null or empty acknowledgment to an empty 202", async () => {
  const notification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
  for (const chunks of [[], [Buffer.from(" \t\r\n")], [Buffer.from("null")], [Buffer.from(" n"), Buffer.from("ul"), Buffer.from("l\n")]]) {
    const client = mcpFixture({ status: 200, chunks, headers: { "content-type": "application/json; charset=utf-8", "mcp-session-id": "bounded-session" } });
    const response = await client.mcpFetch(MCP_URL, { method: "POST", body: notification });
    assert.equal(response.status, 202);
    assert.equal(await response.text(), "");
    assert.equal(response.headers.get("content-type"), null);
    assert.equal(response.headers.get("mcp-session-id"), "bounded-session");
    assert.equal(client.requests.length, 1);
  }
});

test("MCP initialized compatibility rejects nonempty JSON, malformed text, unsolicited responses, and SSE", async () => {
  const notification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
  for (const text of ["{}", "[]", '"null"', "false", "0", "not-json", "nul", "null {}", "\u00a0null", JSON.stringify(MCP_RESPONSE), '{"jsonrpc":"2.0","error":{"code":-32600,"message":"rejected"}}', '{"jsonrpc":"2.0","id":1,"method":"sampling/createMessage"}']) {
    const client = mcpFixture({ chunks: [Buffer.from(text)] });
    await assert.rejects(client.mcpFetch(MCP_URL, { method: "POST", body: notification }), { code: "invalid_json" }, text);
    assert.equal(client.requests.length, 1);
  }
  for (const type of ["text/event-stream", "application/problem+json"]) {
    await assert.rejects(mcpFixture({ headers: { "content-type": type }, chunks: [Buffer.from("null")] }).mcpFetch(MCP_URL, { method: "POST", body: notification }), { code: "invalid_json" });
  }
});

test("MCP empty acknowledgments never substitute for request results or other notifications", async () => {
  const messages = [
    { jsonrpc: "2.0", id: 0, method: "initialize" },
    { jsonrpc: "2.0", id: 0, method: "tools/list" },
    { jsonrpc: "2.0", id: 0, method: "tools/call" },
    { jsonrpc: "2.0", id: 0, method: "notifications/initialized" },
    { jsonrpc: "2.0", method: "notifications/cancelled" },
  ];
  for (const message of messages) {
    for (const text of ["", " \r\n", "null", "{}", JSON.stringify({ ...MCP_RESPONSE, id: 1 })]) {
      await assert.rejects(mcpFixture({ chunks: [Buffer.from(text)] }).mcpFetch(MCP_URL, { method: "POST", body: JSON.stringify(message) }), { code: "invalid_json" });
    }
  }
  const client = mcpFixture({ chunks: [Buffer.from("null")] });
  await assert.rejects(client.mcpFetch(MCP_URL, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: null, method: "notifications/initialized" }) }), { code: "invalid_request" });
  assert.equal(client.requests.length, 0);
});

test("MCP HTTP 200 initialized acknowledgment still requires bounded completed valid UTF-8 input", async () => {
  const notification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
  for (const options of [{ chunks: [Buffer.alloc(128 * 1024 + 1, " ")] }, { chunks: [Buffer.from("null")], headers: { "content-length": "131073" } }]) {
    await assert.rejects(mcpFixture(options).mcpFetch(MCP_URL, { method: "POST", body: notification }), { code: "too_large" });
  }
  await assert.rejects(mcpFixture({ chunks: [Buffer.from([0xff])] }).mcpFetch(MCP_URL, { method: "POST", body: notification }), { code: "invalid_json" });
  await assert.rejects(mcpFixture({ chunks: [Buffer.from("null")], hangBody: true, timeoutMs: 10 }).mcpFetch(MCP_URL, { method: "POST", body: notification }), { code: "timeout" });
  await assert.rejects(mcpFixture({ chunks: [Buffer.from("null")], headers: { "content-encoding": "gzip" } }).mcpFetch(MCP_URL, { method: "POST", body: notification }), { code: "http_error" });
});

test("MCP bounds request bytes and rejects invalid JSON-RPC or header values before I/O", async () => {
  const client = mcpFixture();
  await assert.rejects(client.mcpFetch(MCP_URL, { method: "POST", body: "가".repeat(12_000) }), { code: "too_large" });
  for (const body of [undefined, "not-json", "[]", "null", "{}", JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: null }), new Uint8Array([1, 2])]) {
    await assert.rejects(client.mcpFetch(MCP_URL, { method: "POST", body }), { code: "invalid_request" });
  }
  for (const headers of [{ "Mcp-Session-Id": "bad\nheader" }, { "Mcp-Session-Id": "x".repeat(257) }, { "Mcp-Protocol-Version": "anything" }] as Record<string, string>[]) {
    await assert.rejects(client.mcpFetch(MCP_URL, { method: "POST", body: MCP_BODY, headers }), { code: "invalid_request" });
  }
  assert.equal(client.requests.length, 0);
  assert.equal(client.resolved.length, 0);
});

test("MCP response headers, encoding, sizes, UTF-8, and matching JSON-RPC IDs are validated", async () => {
  for (const headers of [{ "content-type": "text/html" }, { "content-encoding": "gzip" }, { "mcp-session-id": "x".repeat(257) }, { "mcp-session-id": ["one", "two"] }, { "content-length": "invalid" }]) {
    await assert.rejects(mcpFixture({ headers }).mcpFetch(MCP_URL, { method: "POST", body: MCP_BODY }), { code: "http_error" });
  }
  await assert.rejects(mcpFixture({ headers: { "content-length": "131073" } }).mcpFetch(MCP_URL, { method: "POST", body: MCP_BODY }), { code: "too_large" });
  await assert.rejects(mcpFixture({ chunks: [Buffer.alloc(128 * 1024, " "), Buffer.from("!")] }).mcpFetch(MCP_URL, { method: "POST", body: MCP_BODY }), { code: "too_large" });
  for (const body of [Buffer.from("not-json"), Buffer.from([0xff]), Buffer.from(JSON.stringify({ ...MCP_RESPONSE, id: 99 })), Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "server/request" }))]) {
    await assert.rejects(mcpFixture({ chunks: [body] }).mcpFetch(MCP_URL, { method: "POST", body: MCP_BODY }), { code: "invalid_json" });
  }
  const error = { jsonrpc: "2.0", id: 0, error: { code: -32601, message: "Not supported" } };
  const response = await mcpFixture({ chunks: [Buffer.from(JSON.stringify(error))] }).mcpFetch(MCP_URL, { method: "POST", body: MCP_BODY });
  assert.deepEqual(await response.json(), error);
});

test("MCP SSE stops on the matching result and strips server requests and reconnect instructions", async () => {
  const client = mcpFixture({
    headers: { "content-type": "text/event-stream; charset=utf-8" }, hangBody: true,
    chunks: [
      Buffer.from(': keepalive\nretry: 1\nid: reconnect-token\nevent: message\ndata: {"jsonrpc":"2.0","id":99,"method":"sampling/createMessage"}\n\n'),
      Buffer.from('event: message\r'), Buffer.from('\ndata: {"jsonrpc":"2.0",\r\ndata: "id":0,"result":{"text":"한글"}}\r\n\r'), Buffer.from('\n'),
    ],
  });
  const response = await client.mcpFetch(MCP_URL, { method: "POST", body: MCP_BODY });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(await response.text(), 'event: message\ndata: {"jsonrpc":"2.0","id":0,"result":{"text":"한글"}}\n\n');
  assert.equal(client.wasDestroyed(), true);
});

test("MCP SSE supports byte-split UTF-8 and rejects missing, malformed, or oversized results", async () => {
  const event = Buffer.from(`data: ${JSON.stringify({ ...MCP_RESPONSE, result: { text: "한글" } })}\n\n`);
  const response = await mcpFixture({ headers: { "content-type": "text/event-stream" }, chunks: [...event].map(byte => Buffer.from([byte])) }).mcpFetch(MCP_URL, { method: "POST", body: MCP_BODY });
  assert.match(await response.text(), /한글/);
  for (const body of ["data: not-json\n\n", `data: ${JSON.stringify({ ...MCP_RESPONSE, id: 99 })}\n\n`, ": heartbeat\n\n", `data: ${JSON.stringify(MCP_RESPONSE)}`]) {
    await assert.rejects(mcpFixture({ headers: { "content-type": "text/event-stream" }, chunks: [Buffer.from(body)] }).mcpFetch(MCP_URL, { method: "POST", body: MCP_BODY }), { code: "invalid_json" });
  }
  await assert.rejects(mcpFixture({ headers: { "content-type": "text/event-stream" }, chunks: [Buffer.alloc(128 * 1024 + 1, " ")] }).mcpFetch(MCP_URL, { method: "POST", body: MCP_BODY }), { code: "too_large" });
});

test("MCP total deadline includes DNS, connection, JSON body, and persistent SSE waits", async () => {
  for (const options of [
    { resolve: () => new Promise<LookupAddress[]>(() => {}) },
    { hangResponse: true },
    { hangBody: true, chunks: [Buffer.from('{"jsonrpc":')] },
    { hangBody: true, headers: { "content-type": "text/event-stream" }, chunks: [Buffer.from(": keepalive\n\n")] },
  ]) {
    await assert.rejects(mcpFixture({ ...options, timeoutMs: 10 }).mcpFetch(MCP_URL, { method: "POST", body: MCP_BODY }), { code: "timeout" });
  }
});

test("MCP parent and SDK cancellation stop pending I/O without disclosing raw network errors", async () => {
  for (const cancelSdk of [false, true]) {
    const parent = new AbortController();
    const sdk = new AbortController();
    const client = mcpFixture({ hangResponse: true });
    const pending = client.createMcpFetch(MCP_URL, AGENT_PROFILE_URL, parent.signal)(MCP_URL, { method: "POST", body: MCP_BODY, signal: sdk.signal });
    await new Promise<void>(resolve => setImmediate(resolve));
    (cancelSdk ? sdk : parent).abort();
    await assert.rejects(pending, { code: "network_error" });
    assert.equal(client.wasDestroyed(), true);
  }
  const cancelled = mcpFixture();
  await assert.rejects(cancelled.createMcpFetch(MCP_URL, AGENT_PROFILE_URL, AbortSignal.abort())(MCP_URL, { method: "POST", body: MCP_BODY }), { code: "network_error" });
  assert.equal(cancelled.resolved.length, 0);
  await assert.rejects(mcpFixture({ requestError: new Error("private infrastructure diagnostic") }).mcpFetch(MCP_URL, { method: "POST", body: MCP_BODY }), (error: unknown) => {
    assert.ok(error instanceof SafeFetchError);
    assert.equal(error.message.includes("private infrastructure"), false);
    return true;
  });
});

test("checkout GET/PUT retain pinned HTTPS and whitelist UCP/idempotency headers", async () => {
  const client = fixture();
  const headers = { ...UCP_HEADERS, "Idempotency-Key": "22989a91-c7d9-4f83-bd1c-2fbeb0e59a52", Authorization: "never-forward", Cookie: "never-forward" };
  await client.requestUcpJson("https://api.merchant.example/ucp/checkout-sessions/c1", "PUT", { line_items: [] }, headers);
  await client.requestUcpJson("https://api.merchant.example/ucp/checkout-sessions/c1", "GET", undefined, UCP_HEADERS);
  assert.deepEqual(client.requests.map(r => r.method), ["PUT", "GET"]);
  for (const r of client.requests) {
    assert.equal(r.rejectUnauthorized, true);
    assert.equal(typeof r.lookup, "function");
    assert.equal((r.headers as Record<string, string>)["UCP-Agent"], UCP_HEADERS["UCP-Agent"]);
    assert.equal((r.headers as Record<string, string>).Authorization, undefined);
    assert.equal((r.headers as Record<string, string>).Cookie, undefined);
  }
  assert.equal((client.requests[0].headers as Record<string, string>)["Idempotency-Key"], headers["Idempotency-Key"]);
  assert.equal(client.sentBodies[1], undefined);
  await assert.rejects(client.requestUcpJson(CATALOG_URL, "PUT", {}, { ...UCP_HEADERS, "Idempotency-Key": "bad\r\nheader" }), { code: "invalid_request" });
  await assert.rejects(fixture({ addresses: [{ address: "127.0.0.1", family: 4 }] }).requestUcpJson(CATALOG_URL, "PUT", {}, headers), { code: "unsafe_url" });
  await assert.rejects(fixture({ status: 302 }).requestUcpJson(CATALOG_URL, "PUT", {}, headers), { code: "unsafe_url" });
});


test("Bluefern Catalog discovery and requests work unsigned while configured signatures remain valid", async () => {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const encoded = Buffer.from(pair.privateKey.export({ format: "pem", type: "pkcs8" })).toString("base64");
  const profile = parseUcpProfile({ ucp: {
    version: CATALOG_VERSION,
    services: { "dev.ucp.shopping": [{ version: CATALOG_VERSION, transport: "rest", endpoint: "https://api.bluefern.shop/ucp/v1" }] },
    capabilities: { [CATALOG_CAPABILITY]: [{ version: CATALOG_VERSION, schema: "https://ucp.dev/schemas/shopping/catalog_search.json" }] },
    payment_handlers: {},
  } });
  const response = { ucp: { version: CATALOG_VERSION, capabilities: { [CATALOG_CAPABILITY]: [{ version: CATALOG_VERSION }] } }, products: [] };
  for (const configured of [false, true]) {
    const client = fixture({
      sign: createUcpSigner(() => configured ? encoded : undefined, pair.publicKey.export({ format: "jwk" })),
      chunks: [Buffer.from(JSON.stringify(response))],
    });
    const result = await catalogSearch({ domain: "bluefern.shop", profileUrl: "https://bluefern.shop/.well-known/ucp", status: "verified", profile }, "XRPL", {
      signal: new AbortController().signal, platformProfileUrl: "https://agent.example/.well-known/ucp",
    }, {
      fetchProfile: async url => ({ url, body: createPlatformProfile() }),
      requestId: () => UCP_HEADERS["Request-Id"], post: client.postPublicJson,
    });
    assert.equal(result.status, "completed");
    for (const [operation, body] of [["lookup", { ids: ["v1"] }], ["product", { id: "p1" }]] as const) {
      await client.postPublicJson(`https://api.bluefern.shop/ucp/v1/catalog/${operation}`, body, UCP_HEADERS);
    }
    assert.deepEqual(client.requests.map(request => request.path), ["/ucp/v1/catalog/search", "/ucp/v1/catalog/lookup", "/ucp/v1/catalog/product"]);
    for (const [index, request] of client.requests.entries()) {
      const headers = request.headers as Record<string, string>;
      assert.equal(request.hostname, "api.bluefern.shop");
      assert.equal(request.method, "POST");
      assert.equal(headers["Request-Id"], UCP_HEADERS["Request-Id"]);
      assert.equal(headers["UCP-Agent"], UCP_HEADERS["UCP-Agent"]);
      assert.equal(headers["Content-Type"], "application/json");
      if (configured) {
        assert.equal(headers["Content-Digest"], `sha-256=:${createHash("sha256").update(client.sentBodies[index]!).digest("base64")}:`);
        assert.equal(await httpbis.verifyMessage({ keyLookup: async () => ({ verify: async (data, signature) => verify("sha256", data, { key: pair.publicKey, dsaEncoding: "ieee-p1363" }, signature) }) },
          { method: "POST", url: `https://api.bluefern.shop${request.path}`, headers }), true);
      } else {
        assert.equal(headers.Signature, undefined);
        assert.equal(headers["Signature-Input"], undefined);
      }
    }
    assert.deepEqual(JSON.parse(client.sentBodies[0]!.toString()), { query: "XRPL", pagination: { limit: 10 } });
  }
});

test("unsigned Catalog support never permits unsigned Bluefern Checkout operations", async () => {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const client = fixture({ sign: createUcpSigner(() => undefined, pair.publicKey.export({ format: "jwk" })) });
  for (const [method, path] of [
    ["POST", "/checkout-sessions"], ["GET", "/checkout-sessions/c1"], ["PUT", "/checkout-sessions/c1"],
    ["POST", "/checkout-sessions/c1/complete"], ["POST", "/checkout-sessions/c1/cancel"],
  ] as const) {
    await assert.rejects(client.requestUcpJson(`https://api.bluefern.shop/ucp/v1${path}`, method,
      method === "GET" ? undefined : {}, UCP_HEADERS), { code: "signing_not_configured" });
  }
  assert.equal(client.resolved.length, 0);
  assert.equal(client.requests.length, 0);
});

test("shared UCP client signs the exact transmitted buffer and preserves the supplied mutation key", async () => {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const signer = createUcpSigner(() => Buffer.from(pair.privateKey.export({ format: "pem", type: "pkcs8" })).toString("base64"), pair.publicKey.export({ format: "jwk" }));
  const client = fixture({ sign: signer });
  const key = "fa60f550-c2e7-4d1e-897d-cc6d6902f774";
  let serialized = 0;
  const body = { toJSON: () => { serialized++; return { title: "café", quantity: serialized }; } };
  const url = "https://api.merchant.example/ucp/checkout-sessions?test=one%20two";
  await client.requestUcpJson(url, "POST", body, { ...UCP_HEADERS, "Idempotency-Key": key });
  assert.equal(serialized, 1);
  const headers = client.requests[0].headers as Record<string, string>;
  assert.equal(headers["Idempotency-Key"], key);
  assert.equal(headers["Content-Digest"], `sha-256=:${createHash("sha256").update(client.sentBodies[0]!).digest("base64")}:`);
  assert.equal(await httpbis.verifyMessage({ keyLookup: async () => ({ verify: async (data, signature) => verify("sha256", data, { key: pair.publicKey, dsaEncoding: "ieee-p1363" }, signature) }) }, { method: "POST", url, headers }), true);
  const discovery = fixture({ sign: async () => assert.fail("Public profiles are not signed") });
  await discovery.fetchPublicJson(PROFILE_URL);
});

test("credential requests require signing even outside checkout routes, before DNS or HTTPS", async () => {
  const url = "https://platform.example/api/UcpPayment/issue-credential";
  const policy = { requireSignature: true, discardErrorBody: true };
  const missing = fixture();
  await assert.rejects(missing.requestUcpJson(url, "POST", {}, UCP_HEADERS, undefined, policy), { code: "signing_not_configured" });
  assert.equal(missing.requests.length, 0);
  assert.equal(missing.resolved.length, 0);
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const noKey = fixture({ sign: createUcpSigner(() => undefined, pair.publicKey.export({ format: "jwk" })) });
  await assert.rejects(noKey.requestUcpJson(url, "POST", {}, UCP_HEADERS, undefined, policy), { code: "signing_not_configured" });
  assert.equal(noKey.requests.length, 0);
  const signer = createUcpSigner(() => Buffer.from(pair.privateKey.export({ format: "pem", type: "pkcs8" })).toString("base64"), pair.publicKey.export({ format: "jwk" }));
  const client = fixture({ sign: signer });
  const body = { agentPublicId: `agt_${"A".repeat(26)}`, businessId: "biz_fixture", checkoutId: "checkout_fixture" };
  await client.requestUcpJson(url, "POST", body, UCP_HEADERS, undefined, policy);
  const headers = client.requests[0].headers as Record<string, string>;
  assert.deepEqual(JSON.parse(client.sentBodies[0]!.toString()), body);
  assert.equal(headers["Content-Digest"], `sha-256=:${createHash("sha256").update(client.sentBodies[0]!).digest("base64")}:`);
  assert.equal(await httpbis.verifyMessage({ keyLookup: async () => ({ verify: async (data, signature) => verify("sha256", data, { key: pair.publicKey, dsaEncoding: "ieee-p1363" }, signature) }) }, { method: "POST", url, headers }), true);
});

test("credential HTTP errors discard even empty or non-JSON bodies and redirects never follow", async () => {
  for (const status of [400, 401, 403, 500]) {
    const client = fixture({ status, headers: { "content-type": "text/html" }, chunks: [Buffer.from("synthetic-sensitive-upstream-error")] });
    const response = await client.requestUcpJson(CATALOG_URL, "POST", {}, UCP_HEADERS, undefined, { discardErrorBody: true });
    assert.equal(response.status, status);
    assert.equal(response.body, undefined);
    assert.equal(client.requests.length, 1);
  }
  const redirect = fixture({ status: 307, headers: { location: "https://evil.example" } });
  await assert.rejects(redirect.requestUcpJson(CATALOG_URL, "POST", {}, UCP_HEADERS, undefined, { discardErrorBody: true }), { code: "unsafe_url" });
  assert.equal(redirect.requests.length, 1);
});

test("provider authorization uses the unsigned pinned HTTPS transport and rejects private DNS and redirects", async () => {
  const handler = { name: "com.hashtrion.pay", version: "2026-10-16", id: "merchant_local_id", businessId: `biz_${"a".repeat(32)}`,
    environment: "sandbox" as const, assets: ["RLUSD"], schema: "https://pay.hashtrion.com/ucp/payment-handlers/com.hashtrion.pay/schema.json",
    credentialEndpoint: "https://provider-api.example/api/UcpPayment/issue-credential" };
  const body = { version: 1, handler: handler.name, handler_version: handler.version,
    credential_endpoints: { sandbox: [handler.credentialEndpoint], production: [] } };
  const options = { sign: async () => assert.fail("Metadata GET must never invoke the signer"), chunks: [Buffer.from(JSON.stringify(body))] };
  const client = fixture(options);
  await assertCredentialEndpointIdentity(handler, undefined, client.fetchPublicJson);
  assert.equal(client.requests.length, 1);
  assert.equal(client.requests[0].method, "GET");
  assert.equal(client.requests[0].hostname, "pay.hashtrion.com");
  assert.equal(client.requests[0].servername, "pay.hashtrion.com");
  assert.equal(client.requests[0].rejectUnauthorized, true);
  assert.deepEqual(client.sentBodies, [undefined]);
  const headers = client.requests[0].headers as Record<string, string>;
  assert.ok(Object.keys(headers).every(name => !/signature|ucp-agent|idempotency/i.test(name)));
  const blocked = fixture({ ...options, addresses: [{ address: "127.0.0.1", family: 4 }] });
  await assert.rejects(assertCredentialEndpointIdentity(handler, undefined, blocked.fetchPublicJson), { code: "credential_endpoint_untrusted" });
  assert.equal(blocked.requests.length, 0);
  const redirect = fixture({ ...options, status: 307, headers: { location: "https://evil.example/metadata.json" } });
  await assert.rejects(assertCredentialEndpointIdentity(handler, undefined, redirect.fetchPublicJson), { code: "credential_endpoint_untrusted" });
  assert.equal(redirect.requests.length, 1);
});


const completionConnection = { domain: "merchant.example", endpoint: "https://api.merchant.example/ucp/v1", platform: "https://agent.example/.well-known/ucp" };
const completionKey = "4cc57752-b91e-4326-a848-45d614272f36";
const completionBody = { payment: { instruments: [{ id: completionKey, handler_id: "merchant_specific_handler", type: "digital_asset", network: "xrpl", asset: "RLUSD", selected: true,
  credential: { type: "hashtrion_authorization", token: "synthetic-private-completion-token", expiry: "2099-01-01T00:00:00Z" } }] } };
function completionResponse(status = "completed") {
  return { ucp: { version: "2026-08-25", status: "success", capabilities: { "dev.ucp.shopping.checkout": [{ version: "2026-08-25" }] } },
    id: "c1", status, currency: "USD", expires_at: "2099-01-01T00:00:00Z", line_items: [{ id: "l1", item: { id: "v1", title: "Report", price: 400 }, quantity: 1 }], totals: [{ type: "total", amount: 400 }],
    ...(status === "completed" ? { order: { id: "order_1", permalink_url: "https://api.merchant.example/orders/order_1" } } : {}) };
}

test("existing checkoutRequest sends one signed Complete POST with the exact instrument, key and safe result projection", async () => {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const sign = createUcpSigner(() => Buffer.from(pair.privateKey.export({ format: "pem", type: "pkcs8" })).toString("base64"), pair.publicKey.export({ format: "jwk" }));
  for (const status of ["completed", "complete_in_progress"]) {
    const client = fixture({ sign, chunks: [Buffer.from(JSON.stringify(completionResponse(status)))] });
    const result = await checkoutRequest(completionConnection, "complete", "c1", completionBody, completionKey, new AbortController().signal, client.requestUcpJson);
    assert.equal(client.requests.length, 1);
    assert.equal(client.requests[0].method, "POST");
    assert.equal(client.requests[0].path, "/ucp/v1/checkout-sessions/c1/complete");
    assert.deepEqual(JSON.parse(client.sentBodies[0]!.toString()), completionBody);
    const headers = client.requests[0].headers as Record<string, string>;
    assert.equal(headers["Idempotency-Key"], completionKey);
    assert.equal(headers["UCP-Agent"], UCP_HEADERS["UCP-Agent"]);
    assert.equal(headers["Content-Digest"], `sha-256=:${createHash("sha256").update(client.sentBodies[0]!).digest("base64")}:`);
    assert.equal(await httpbis.verifyMessage({ keyLookup: async () => ({ verify: async (data, signature) => verify("sha256", data, { key: pair.publicKey, dsaEncoding: "ieee-p1363" }, signature) }) },
      { method: "POST", url: "https://api.merchant.example/ucp/v1/checkout-sessions/c1/complete", headers }), true);
    assert.equal(result.status, status);
    assert.equal(result.order?.id, status === "completed" ? "order_1" : undefined);
    assert.equal(result.order?.permalinkUrl, status === "completed" ? "https://api.merchant.example/orders/order_1" : undefined);
    assert.ok(!JSON.stringify(result).includes("synthetic-private-completion-token"));
  }
});

test("Complete preserves safe transport and UCP business errors and rejects missing orders or credential echoes", async () => {
  const scenarios = [
    { status: 503, body: { ucp: { version: "2026-08-25", status: "error" }, code: "payment_processing_unavailable", content: "private upstream detail" }, code: "payment_processing_unavailable" },
    { status: 503, body: { code: "private unknown code", content: "private upstream detail" }, code: "merchant_error" },
    { status: 200, body: { ucp: { version: "2026-08-25", status: "error" }, messages: [{ type: "error", code: "payment_failed", content: "private upstream detail" }] }, code: "payment_failed" },
    { status: 200, body: { ...completionResponse(), order: undefined }, code: "invalid_checkout_response" },
    { status: 200, body: { ...completionResponse(), payment: completionBody.payment }, code: "credential_echo_blocked" },
    { status: 503, body: { code: "payment_processing_unavailable", content: completionBody.payment.instruments[0].credential.token }, code: "credential_echo_blocked" },
  ];
  for (const { status, body, code } of scenarios) {
    const client = fixture({ status, chunks: [Buffer.from(JSON.stringify(body))] });
    await assert.rejects(checkoutRequest(completionConnection, "complete", "c1", completionBody, completionKey, new AbortController().signal, client.requestUcpJson), { code, message: code });
    assert.equal(client.requests.length, 1);
  }
});

test("Complete retains shared transport protections against redirects, private DNS and timeouts without retry", async () => {
  const scenarios: [Parameters<typeof fixture>[0], string][] = [
    [{ status: 307, headers: { location: "https://evil.example/complete" } }, "unsafe_url"],
    [{ addresses: [{ address: "127.0.0.1", family: 4 }] }, "unsafe_url"],
    [{ hangResponse: true, timeoutMs: 10 }, "timeout"],
  ];
  for (const [options, code] of scenarios) {
    const client = fixture(options);
    await assert.rejects(checkoutRequest(completionConnection, "complete", "c1", completionBody, completionKey, new AbortController().signal, client.requestUcpJson), { code });
    assert.ok(client.requests.length <= 1);
  }
});

const flushRequests = () => new Promise<void>(resolve => setImmediate(resolve));
for (const status of ["completed", "complete_in_progress"]) {
  test(`Complete accepts ${status} after seven seconds with the production timeout policy`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const client = fixture({ productionTimeouts: true, responseDelayMs: 7_000,
      chunks: [Buffer.from(JSON.stringify(completionResponse(status)))] });
    let settled = false;
    const result = checkoutRequest(completionConnection, "complete", "c1", completionBody, completionKey,
      new AbortController().signal, client.requestUcpJson).finally(() => { settled = true; });
    await flushRequests();
    t.mock.timers.tick(6_001); await flushRequests();
    assert.equal(settled, false); assert.equal(client.wasDestroyed(), false);
    t.mock.timers.tick(999);
    const checkout = await result;
    assert.equal(checkout.status, status);
    assert.equal(checkout.order?.id, status === "completed" ? "order_1" : undefined);
    assert.equal(client.requests.length, 1);
  });
}

test("Complete stops at 45 seconds and never retries", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = fixture({ productionTimeouts: true, hangResponse: true });
  let settled = false;
  const result = checkoutRequest(completionConnection, "complete", "c1", completionBody, completionKey,
    new AbortController().signal, client.requestUcpJson).finally(() => { settled = true; });
  const rejected = assert.rejects(result, { code: "timeout" });
  await flushRequests();
  t.mock.timers.tick(44_999); await flushRequests(); assert.equal(settled, false);
  t.mock.timers.tick(1); await rejected;
  assert.equal(client.wasDestroyed(), true); assert.equal(client.requests.length, 1);
});

test("ordinary reads and mutations retain six seconds even if given a Complete policy", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const method of ["GET", "POST", "PUT"] as const) {
    const client = fixture({ productionTimeouts: true, hangResponse: true });
    const result = client.requestUcpJson("https://api.merchant.example/ucp/v1/checkout-sessions/c1", method,
      method === "GET" ? undefined : {}, UCP_HEADERS, undefined, { timeoutPolicy: "complete_checkout" });
    const rejected = assert.rejects(result, { code: "timeout" });
    await flushRequests(); t.mock.timers.tick(6_000); await rejected;
    assert.equal(client.wasDestroyed(), true); assert.equal(client.requests.length, 1);
  }
});

test("Complete still observes caller abort and network failure without a second request", async () => {
  for (const fault of ["abort", "network"] as const) {
    const caller = new AbortController();
    const client = fixture({ productionTimeouts: true, hangResponse: fault === "abort",
      ...(fault === "network" ? { requestError: new Error("Synthetic connection failure") } : {}) });
    const result = checkoutRequest(completionConnection, "complete", "c1", completionBody, completionKey,
      caller.signal, client.requestUcpJson);
    const rejected = assert.rejects(result, { code: "network_error" });
    await flushRequests();
    if (fault === "abort") caller.abort();
    await rejected;
    assert.equal(client.requests.length, 1); assert.equal(client.wasDestroyed(), true);
  }
});


test("credential POST accepts a response after 7.4 seconds", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = fixture({ productionTimeouts: true, responseDelayMs: 7_400 });
  const result = client.requestUcpJson("https://platform.example/api/UcpPayment/issue-credential", "POST",
    {}, UCP_HEADERS, undefined, { timeoutPolicy: "issue_credential" });
  await flushRequests();
  t.mock.timers.tick(7_400);
  assert.equal((await result).status, 200);
  assert.equal(client.requests.length, 1);
  assert.equal(client.wasDestroyed(), false);
});

test("credential POST stops at 15 seconds without retry", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = fixture({ productionTimeouts: true, hangResponse: true });
  let settled = false;
  const result = client.requestUcpJson("https://platform.example/api/UcpPayment/issue-credential", "POST",
    {}, UCP_HEADERS, undefined, { timeoutPolicy: "issue_credential" }).finally(() => { settled = true; });
  const rejected = assert.rejects(result, { code: "timeout" });
  await flushRequests();
  t.mock.timers.tick(14_999); await flushRequests(); assert.equal(settled, false);
  t.mock.timers.tick(1); await rejected;
  assert.equal(client.wasDestroyed(), true);
  assert.equal(client.requests.length, 1);
});

test("credential timeout policy does not extend other requests", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [method, path] of [["GET", "/api/UcpPayment/issue-credential"],
    ["PUT", "/api/UcpPayment/issue-credential"], ["POST", "/other"]] as const) {
    const client = fixture({ productionTimeouts: true, hangResponse: true });
    const result = client.requestUcpJson(`https://platform.example${path}`, method,
      method === "GET" ? undefined : {}, UCP_HEADERS, undefined, { timeoutPolicy: "issue_credential" });
    const rejected = assert.rejects(result, { code: "timeout" });
    await flushRequests(); t.mock.timers.tick(6_000); await rejected;
    assert.equal(client.requests.length, 1);
  }
});
