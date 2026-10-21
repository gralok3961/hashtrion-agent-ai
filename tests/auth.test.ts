import assert from "node:assert/strict";
import test from "node:test";
import {
  authenticateRequest, createSessionToken, handleLogin, handleLogout,
  isAuthenticatedSession, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS,
  trustedMutationOrigin,
} from "../src/lib/server/auth";
import { createLoginGuard } from "../src/lib/server/login-guard";

const env = {
  AGENT_AI_ACCESS_PASSWORD: "synthetic-hackathon-password",
  AGENT_AI_SESSION_SECRET: "synthetic-session-secret-with-at-least-32-bytes",
};
const time = 1_800_000_000_000;
function request(body: unknown = { password: env.AGENT_AI_ACCESS_PASSWORD }, extra: Record<string, string> = {}) {
  return new Request("https://agent.example/api/auth/login", {
    method: "POST", headers: { origin: "https://agent.example", host: "agent.example", "content-type": "application/json", ...extra },
    body: JSON.stringify(body),
  });
}
function loginOptions() {
  return { env, now: () => time, guard: createLoginGuard({ now: () => time }) };
}

test("signed sessions expire absolutely after twelve hours and reject future issuance", () => {
  const token = createSessionToken(env, time);
  assert.ok(token);
  assert.equal(isAuthenticatedSession(token, env, time), true);
  assert.equal(isAuthenticatedSession(token, env, time + SESSION_MAX_AGE_SECONDS * 1_000 - 1), true);
  assert.equal(isAuthenticatedSession(token, env, time + SESSION_MAX_AGE_SECONDS * 1_000), false);
  assert.equal(isAuthenticatedSession(token, env, time - 1), false);
});

test("sessions reject tampering, noncanonical tokens, wrong credentials, and bad clocks", () => {
  const token = createSessionToken(env, time)!;
  const pieces = token.split(".");
  assert.equal(isAuthenticatedSession(`${token}x`, env, time), false);
  assert.equal(isAuthenticatedSession(`v2.${pieces.slice(1).join(".")}`, env, time), false);
  assert.equal(isAuthenticatedSession(`v1.0${pieces[1]}.${pieces[2]}.${pieces[3]}`, env, time), false);
  assert.equal(isAuthenticatedSession(`v1.${pieces[1]}.${"A".repeat(43)}.${pieces[3]}`, env, time), false);
  assert.equal(isAuthenticatedSession(token, { ...env, AGENT_AI_SESSION_SECRET: "another-synthetic-session-secret-32bytes" }, time), false);
  assert.equal(isAuthenticatedSession(token, { ...env, AGENT_AI_ACCESS_PASSWORD: "another-synthetic-password" }, time), false);
  assert.equal(isAuthenticatedSession(token, env, Number.NaN), false);
  assert.equal(isAuthenticatedSession("x".repeat(10_000), env, time), false);
  assert.equal(createSessionToken(env, Number.NaN), null);
});

test("authentication fails closed when credential configuration is absent or weak", () => {
  const token = createSessionToken(env, time)!;
  const invalid = [
    {}, { ...env, AGENT_AI_ACCESS_PASSWORD: "" },
    { ...env, AGENT_AI_ACCESS_PASSWORD: "x".repeat(1_025) },
    { ...env, AGENT_AI_SESSION_SECRET: "short" },
    { ...env, AGENT_AI_SESSION_SECRET: "x".repeat(4_097) },
  ];
  for (const config of invalid) {
    assert.equal(createSessionToken(config, time), null);
    assert.equal(isAuthenticatedSession(token, config, time), false);
  }
});

test("request authentication rejects missing, oversized, and duplicate cookies", () => {
  const token = createSessionToken(env, time)!;
  const signedCookie = `${SESSION_COOKIE_NAME}=${token}`;
  assert.equal(authenticateRequest(request({}, { cookie: signedCookie }), env, time), true);
  assert.equal(authenticateRequest(request({}, { cookie: `other=ok; ${signedCookie}` }), env, time), true);
  assert.equal(authenticateRequest(request(), env, time), false);
  assert.equal(authenticateRequest(request({}, { cookie: `${signedCookie}; ${signedCookie}` }), env, time), false);
  assert.equal(authenticateRequest(request({}, { cookie: "x".repeat(8_193) }), env, time), false);
  const forbiddenEnv = new Proxy({}, { get() { throw new Error("Credentials must not be read."); } });
  assert.equal(authenticateRequest(request(), forbiddenEnv, time), false);
  assert.equal(authenticateRequest(request({}, { cookie: `${SESSION_COOKIE_NAME}=invalid` }), forbiddenEnv, time), false);
});

test("mutation origin allows HTTPS Azure proxy and localhost, rejects forged forwarded host", () => {
  assert.equal(trustedMutationOrigin(request()), true);
  assert.equal(trustedMutationOrigin(new Request("http://internal-host/api/chat", {
    headers: { origin: "https://agent.example", host: "agent.example" },
  })), true);
  assert.equal(trustedMutationOrigin(new Request("http://localhost:3000/api/chat", {
    headers: { origin: "http://localhost:3000" },
  })), true);
  const invalidHeaders: Array<Record<string, string>> = [
    { origin: "https://evil.example" }, { origin: "null" }, { origin: "" },
    { origin: "http://agent.example" }, { origin: "https://agent.example/" },
    { origin: "https://agent.example", "sec-fetch-site": "cross-site" },
    { origin: "https://evil.example", "x-forwarded-host": "evil.example" },
  ];
  for (const headers of invalidHeaders) assert.equal(trustedMutationOrigin(request({}, headers)), false);
});

test("successful login returns a secure host-only session and does not reveal credentials", async () => {
  const response = await handleLogin(request(), loginOptions());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const cookie = response.headers.get("set-cookie")!;
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE_NAME}=`));
  assert.match(cookie, /Max-Age=43200; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
  assert.doesNotMatch(cookie, /Domain=/i);
  assert.equal(isAuthenticatedSession(cookie.split(";")[0].split("=")[1], env, time), true);
  const text = await response.text();
  assert.equal(text.includes(env.AGENT_AI_ACCESS_PASSWORD), false);
  assert.equal(text.includes(env.AGENT_AI_SESSION_SECRET), false);
});

test("a short configured password authenticates only an exact match and issues a valid session", async () => {
  const shortPasswordEnv = { ...env, AGENT_AI_ACCESS_PASSWORD: "1234" };
  const options = { ...loginOptions(), env: shortPasswordEnv };
  const response = await handleLogin(request({ password: "1234" }), options);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")!;
  assert.match(cookie, /Max-Age=43200; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
  assert.equal(authenticateRequest(request({}, { cookie: cookie.split(";")[0] }), shortPasswordEnv, time), true);
  for (const password of ["1235", "1234 ", " 1234"]) {
    const mismatch = await handleLogin(request({ password }), options);
    assert.equal(mismatch.status, 401);
    assert.equal(mismatch.headers.has("set-cookie"), false);
  }
  const differentlyConfigured = await handleLogin(request({ password: "1234" }), loginOptions());
  assert.equal(differentlyConfigured.status, 401);
  assert.equal(differentlyConfigured.headers.has("set-cookie"), false);
});

test("a short access password still requires an independent strong session secret", async () => {
  for (const secret of [undefined, "", "1234"]) {
    const config = { ...env, AGENT_AI_ACCESS_PASSWORD: "1234", AGENT_AI_SESSION_SECRET: secret };
    const response = await handleLogin(request({ password: "1234" }), { ...loginOptions(), env: config });
    assert.equal(response.status, 503);
    assert.equal(response.headers.has("set-cookie"), false);
    assert.equal(createSessionToken(config, time), null);
  }
});

test("invalid password returns 401; missing server configuration returns safe 503", async () => {
  assert.equal((await handleLogin(request({ password: "wrong-password" }), loginOptions())).status, 401);
  const response = await handleLogin(request(), { ...loginOptions(), env: {} });
  assert.equal(response.status, 503);
  assert.equal(response.headers.has("set-cookie"), false);
  assert.deepEqual(await response.json(), { error: "Login is not configured. Contact the organizer." });
});

test("login checks origins, content type, bounded bodies, and malformed JSON", async () => {
  assert.equal((await handleLogin(request({}, { origin: "https://evil.example" }), loginOptions())).status, 403);
  assert.equal((await handleLogin(request({}, { "content-type": "text/plain" }), loginOptions())).status, 415);
  assert.equal((await handleLogin(request({ password: "x".repeat(5_000) }), loginOptions())).status, 413);
  assert.equal((await handleLogin(request({ password: "x".repeat(1_025) }), loginOptions())).status, 400);
  assert.equal((await handleLogin(request({ password: 1 }), loginOptions())).status, 400);
  const malformed = new Request("https://agent.example/api/auth/login", {
    method: "POST", headers: { origin: "https://agent.example", "content-type": "application/json" }, body: "{",
  });
  assert.equal((await handleLogin(malformed, loginOptions())).status, 400);
});

test("login rejects aborted bodies without waiting for stream completion", async () => {
  const controller = new AbortController();
  const aborted = new Request("https://agent.example/api/auth/login", {
    method: "POST", signal: controller.signal,
    headers: { origin: "https://agent.example", "content-type": "application/json" }, body: "{}",
  });
  controller.abort();
  assert.equal((await handleLogin(aborted, loginOptions())).status, 408);
});

test("global login protection counts successes and malformed attempts; spoofed IP cannot bypass", async () => {
  const options = loginOptions();
  assert.equal((await handleLogin(request(), options)).status, 200);
  for (let attempt = 1; attempt < 10; attempt++) {
    assert.equal((await handleLogin(request({}, { "content-type": "text/plain" }), options)).status, 415);
  }
  const response = await handleLogin(request({}, { "x-forwarded-for": "203.0.113.99" }), options);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "900");
});

test("logout requires same origin and clears the cookie with identical security attributes", async () => {
  assert.equal(handleLogout(request({}, { origin: "https://evil.example" })).status, 403);
  const response = handleLogout(request());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie")!, /Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
  assert.deepEqual(await response.json(), { authenticated: false });
});

test("login guard uses rolling expiry and fails closed after a backwards clock", () => {
  let time = 1_000_000;
  const guard = createLoginGuard({ now: () => time, limit: 1 });
  assert.equal(guard.attempt().allowed, true);
  assert.equal(guard.attempt().allowed, false);
  time -= 1_000;
  assert.equal(guard.attempt().allowed, false);
  time += 15 * 60_000;
  assert.equal(guard.attempt().allowed, false);
  time += 1_000;
  assert.equal(guard.attempt().allowed, true);
  time = Number.NaN;
  assert.equal(guard.attempt().allowed, false);
  for (const limit of [0, -1, 1.5, Infinity, Number.NaN]) assert.throws(() => createLoginGuard({ limit }), RangeError);
});
