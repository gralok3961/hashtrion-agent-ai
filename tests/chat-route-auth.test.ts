import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { Responses } from "openai/resources/responses/responses";
import { GET as getPlatformProfile } from "../src/app/.well-known/ucp/route";
import { POST } from "../src/app/api/chat/route";
import { POST as login } from "../src/app/api/auth/login/route";
import type { ModelResponse, ResponseParameters } from "../src/lib/server/discovery";

const ORIGIN = "https://agent.example";
const SYNTHETIC_PASSWORD = "route-test-password-not-a-real-secret";
const SYNTHETIC_SESSION_SECRET = "route-test-signing-secret-not-a-real-credential-0123456789";

beforeEach(() => {
  // Assign only synthetic fixtures. Never load .env or read real credentials.
  Object.assign(process.env, {
    AGENT_AI_ACCESS_PASSWORD: SYNTHETIC_PASSWORD,
    AGENT_AI_SESSION_SECRET: SYNTHETIC_SESSION_SECRET,
    OPENAI_API_KEY: "route-test-key-not-a-real-openai-credential",
    OPENAI_MODEL: "route-test-model",
    OPENAI_BASE_URL: "https://openai.invalid/v1",
    OPENAI_ORG_ID: "route-test-organization",
    OPENAI_PROJECT_ID: "route-test-project",
    NODE_ENV: "production",
    WEBSITE_INSTANCE_ID: "route-test-azure-instance",
    MERCHANT_DISCOVERY_ENABLED: "true",
    UCP_PLATFORM_PROFILE_URL: `${ORIGIN}/.well-known/ucp`,
  });
  mock.method(globalThis, "fetch", async () => {
    assert.fail("Route authentication tests must never make a network request.");
  });
});

afterEach(() => mock.restoreAll());

function textResponse(): ModelResponse {
  return { status: "completed", output_text: "A mocked assistant reply.", output: [] };
}

function mockResponses(responses: ModelResponse[] = [textResponse()]) {
  const calls: ResponseParameters[] = [];
  mock.method(Responses.prototype, "create", async (parameters: ResponseParameters) => {
    calls.push(parameters);
    const result = responses[calls.length - 1];
    assert.ok(result, "Unexpected additional OpenAI call");
    return result;
  });
  return calls;
}

function chatRequest(headers: Record<string, string> = {}, body = JSON.stringify({
  messages: [{ role: "user", content: "Hello." }],
})) {
  return new Request(`${ORIGIN}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "agent.example", ...headers }, body,
  });
}

let sessionCookie: string | undefined;
async function loggedInCookie(): Promise<string> {
  if (sessionCookie) return sessionCookie;
  const response = await login(new Request(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "agent.example" },
    body: JSON.stringify({ password: SYNTHETIC_PASSWORD }),
  }));
  assert.equal(response.status, 200);
  const header = response.headers.get("set-cookie");
  assert.ok(header, "Successful login must issue a session cookie");
  assert.match(header, /(?:^|;)\s*HttpOnly(?:;|$)/i);
  assert.match(header, /(?:^|;)\s*Secure(?:;|$)/i);
  assert.match(header, /(?:^|;)\s*SameSite=Strict(?:;|$)/i);
  assert.match(header, /(?:^|;)\s*Max-Age=43200(?:;|$)/i);
  sessionCookie = header.split(";")[0];
  return sessionCookie;
}

test("an unauthenticated request is rejected before parsing its body or calling OpenAI", async () => {
  const calls = mockResponses();
  const request = chatRequest({}, "not valid JSON");
  assert.ok(request.body);
  const bodyReader = mock.method(request.body, "getReader", () => {
    assert.fail("An unauthorized request body must not be read.");
  });
  const response = await POST(request);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(bodyReader.mock.callCount(), 0);
  assert.equal(calls.length, 0);
});

test("missing login configuration fails closed without OpenAI usage", async () => {
  delete process.env.AGENT_AI_ACCESS_PASSWORD;
  delete process.env.AGENT_AI_SESSION_SECRET;
  const calls = mockResponses();
  const response = await POST(chatRequest());
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test("malformed and tampered session cookies cannot access the paid chat route", async () => {
  const calls = mockResponses();
  const cookie = await loggedInCookie();
  const prefix = cookie.slice(0, cookie.indexOf("=") + 1);
  for (const invalidCookie of [prefix + "invalid", cookie.slice(0, -10) + "tampered"]) {
    const response = await POST(chatRequest({ Cookie: invalidCookie }));
    assert.equal(response.status, 401);
  }
  assert.equal(calls.length, 0);
});

test("a session older than twelve hours cannot access chat or spend OpenAI credits", async () => {
  const calls = mockResponses();
  const cookie = await loggedInCookie();
  const expiredTime = Date.now() + 13 * 60 * 60 * 1_000;
  mock.method(Date, "now", () => expiredTime);
  const response = await POST(chatRequest({ Cookie: cookie }));
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test("a signed-in request with a cross-site, missing, or opaque origin is rejected before OpenAI", async () => {
  const calls = mockResponses();
  const cookie = await loggedInCookie();
  for (const origin of ["https://other.example", "null", undefined]) {
    const request = chatRequest({ Cookie: cookie });
    if (origin === undefined) request.headers.delete("origin");
    else request.headers.set("origin", origin);
    const response = await POST(request);
    assert.equal(response.status, 403);
  }
  assert.equal(calls.length, 0);
});

test("a valid login permits normal chat using the configured model", async () => {
  const calls = mockResponses();
  const cookie = await loggedInCookie();
  const response = await POST(chatRequest({ Cookie: cookie }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const reply = await response.json();
  assert.deepEqual(reply.message, { role: "assistant", content: "A mocked assistant reply.", shopping: { stage: "browsing" } });
  assert.match(reply.conversationId, /^[0-9a-f-]{36}$/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "route-test-model");
});

test("invalid supplied Agent IDs fail before reserving paid chat or calling OpenAI", async () => {
  const calls = mockResponses();
  const cookie = await loggedInCookie();
  // More than the per-minute paid-request budget: invalid context must not use it.
  const invalidIds = [null, "", 1234, {}, [], "agt_ABC", `agt_${"A".repeat(25)}0`, `agt_${"a".repeat(26)}`];
  for (let i = 0; i < 24; i++) {
    const response = await POST(chatRequest({ Cookie: cookie }, JSON.stringify({
      messages: [{ role: "user", content: "Hello." }], agentId: invalidIds[i % invalidIds.length],
    })));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(calls.length, 0);
  // Optional requests continue working after malformed Agent ID attempts.
  const response = await POST(chatRequest({ Cookie: cookie }));
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
});

test("only Agent ID presence reaches model context; the actual ID stays private", async () => {
  const calls = mockResponses([textResponse(), textResponse()]);
  const cookie = await loggedInCookie();
  const agentId = "agt_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const response = await POST(chatRequest({ Cookie: cookie }, JSON.stringify({
    messages: [{ role: "user", content: "Hello." }], agentId,
  })));
  assert.equal(response.status, 200);
  const reply = await response.json();
  assert.deepEqual(reply.message, { role: "assistant", content: "A mocked assistant reply.", shopping: { stage: "browsing" } });
  assert.match(reply.conversationId, /^[0-9a-f-]{36}$/);
  const withoutId = await POST(chatRequest({ Cookie: cookie }));
  assert.equal(withoutId.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(String(calls[0].instructions).includes('"hasAgentId":true'));
  assert.ok(String(calls[1].instructions).includes('"hasAgentId":false'));
  assert.deepEqual({ ...calls[0], instructions: String(calls[0].instructions).replace('"hasAgentId":true', '"hasAgentId":false') }, calls[1]);
  assert.ok(!JSON.stringify(calls).includes(agentId));
  assert.ok(!JSON.stringify(calls).includes("agentId"));
});

test("authenticated requests still require valid content type, JSON, and chat history", async () => {
  const calls = mockResponses();
  const cookie = await loggedInCookie();
  const cases = [
    { request: chatRequest({ Cookie: cookie, "Content-Type": "text/plain" }), status: 415 },
    { request: chatRequest({ Cookie: cookie }, "not JSON"), status: 400 },
    { request: chatRequest({ Cookie: cookie }, JSON.stringify({ messages: [{ role: "system", content: "Hello." }] })), status: 400 },
  ];
  for (const { request, status } of cases) {
    assert.equal((await POST(request)).status, status);
  }
  assert.equal(calls.length, 0);
});

for (const name of ["discover_merchants", "search_catalog"]) {
  test(`authenticated Azure production ${name} reaches web search when opted in`, async () => {
    const query = name === "discover_merchants" ? { query: "research report merchants" } : {
      query: "research reports", merchant_domain: null, merchant_name: "Named Store",
    };
    const calls = mockResponses([
      { status: "completed", output_text: "", output: [{
        type: "function_call", name, call_id: `call_${name}`, arguments: JSON.stringify(query),
      }] },
      { status: "completed", output_text: "No search sources were returned.", output: [] },
    ]);
    const cookie = await loggedInCookie();
    const response = await POST(chatRequest({ Cookie: cookie }, JSON.stringify({ messages: [{ role: "user", content: "Find research reports from Named Store" }] })));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.message.discovery.status, "no_sources");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].tools, [{ type: "web_search", search_context_size: "low" }]);
  });
}

test("authenticated users remain subject to the shared two-request concurrency ceiling", async () => {
  const cookie = await loggedInCookie();
  let releaseReplies!: () => void;
  const waiting = new Promise<void>(resolve => { releaseReplies = resolve; });
  const create = mock.method(Responses.prototype, "create", async () => {
    await waiting;
    return textResponse();
  });
  const first = POST(chatRequest({ Cookie: cookie }));
  const second = POST(chatRequest({ Cookie: cookie }));
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(create.mock.callCount(), 2);
    const response = await POST(chatRequest({ Cookie: cookie }));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "60");
    assert.equal(create.mock.callCount(), 2);
  } finally {
    releaseReplies();
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
  }
});

test("the UCP platform profile remains public even without authentication configuration", async () => {
  delete process.env.AGENT_AI_ACCESS_PASSWORD;
  delete process.env.AGENT_AI_SESSION_SECRET;
  const calls = mockResponses();
  const response = getPlatformProfile();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.match(response.headers.get("cache-control") ?? "", /^public/);
  const body = await response.json();
  assert.ok(body.ucp.version);
  assert.ok(body.ucp.capabilities["dev.ucp.shopping.catalog.search"]);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(calls.length, 0);
});

test("another authenticated session cannot use a stolen conversation ID to access checkout tools", async () => {
  const calls = mockResponses();
  const ownerCookie = await loggedInCookie();
  const first = await POST(chatRequest({ Cookie: ownerCookie }));
  const { conversationId } = await first.json();
  const otherLogin = await login(new Request(`${ORIGIN}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, Host: "agent.example" },
    body: JSON.stringify({ password: SYNTHETIC_PASSWORD }),
  }));
  assert.equal(otherLogin.status, 200);
  const otherCookie = otherLogin.headers.get("set-cookie")!.split(";")[0];
  assert.notEqual(otherCookie, ownerCookie);
  const attempted = await POST(chatRequest({ Cookie: otherCookie }, JSON.stringify({
    messages: [{ role: "user", content: "Check my checkout" }], conversationId, action: { type: "status" }, checkoutId: "untrusted-checkout-id",
  })));
  assert.equal(attempted.status, 409);
  assert.equal(calls.length, 1, "Ownership fails before GPT and checkout dispatch");
});
