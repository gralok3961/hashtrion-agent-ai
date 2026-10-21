import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { loginGuard } from "./login-guard";

export const SESSION_COOKIE_NAME = "__Host-hashtrion-agent-session";
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const MAX_PASSWORD_BYTES = 1_024;
const MAX_LOGIN_BODY_BYTES = 4_096;
const LOGIN_BODY_TIMEOUT_MS = 5_000;
const COOKIE_ATTRIBUTES = "Path=/; HttpOnly; Secure; SameSite=Strict";
export type AuthEnvironment = Readonly<Record<string, string | undefined>>;

function authConfig(env: AuthEnvironment) {
  const password = env.AGENT_AI_ACCESS_PASSWORD;
  const secret = env.AGENT_AI_SESSION_SECRET;
  if (
    typeof password !== "string" ||
    password.length === 0 ||
    Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES ||
    typeof secret !== "string" ||
    Buffer.byteLength(secret, "utf8") < 32 ||
    Buffer.byteLength(secret, "utf8") > 4_096
  ) {
    return null;
  }
  const passwordHash = createHash("sha256").update(password, "utf8").digest();
  // Rotating either configured secret invalidates existing sessions.
  const signingKey = createHmac("sha256", secret)
    .update("hashtrion-agent-session:v1\0")
    .update(passwordHash)
    .digest();
  return { passwordHash, signingKey };
}

function sign(payload: string, key: Buffer) {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function createSessionToken(
  env: AuthEnvironment = process.env,
  nowMs = Date.now()
): string | null {
  const config = authConfig(env);
  const issued = Math.floor(nowMs / 1_000);
  if (!config || !Number.isSafeInteger(issued) || issued <= 0 || issued > 999_999_999_999) {
    return null;
  }
  const payload = `v1.${issued}.${randomBytes(32).toString("base64url")}`;
  return `${payload}.${sign(payload, config.signingKey)}`;
}

export function isAuthenticatedSession(
  value: string | undefined,
  env: AuthEnvironment = process.env,
  nowMs = Date.now()
): boolean {
  if (!value || value.length > 160 || !Number.isFinite(nowMs)) {
    return false;
  }
  const match = /^v1\.([1-9]\d{0,11})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) {
    return false;
  }
  const issuedMs = Number(match[1]) * 1_000;
  if (nowMs < issuedMs || nowMs >= issuedMs + SESSION_MAX_AGE_SECONDS * 1_000) {
    return false;
  }
  const signature = Buffer.from(match[3], "base64url");
  if (
    signature.toString("base64url") !== match[3] ||
    Buffer.from(match[2], "base64url").toString("base64url") !== match[2]
  ) {
    return false;
  }
  const config = authConfig(env);
  if (!config) {
    return false;
  }
  const expected = Buffer.from(
    sign(value.slice(0, value.lastIndexOf(".")), config.signingKey),
    "base64url"
  );
  return signature.length === expected.length && timingSafeEqual(signature, expected);
}

export function authenticateRequest(
  request: Request,
  env: AuthEnvironment = process.env,
  nowMs = Date.now()
): boolean {
  const cookie = request.headers.get("cookie");
  if (!cookie || cookie.length > 8_192) {
    return false;
  }
  const values = cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (values.length !== 1) {
    return false;
  }
  return isAuthenticatedSession(values[0].slice(SESSION_COOKIE_NAME.length + 1), env, nowMs);
}

/** Azure terminates TLS before Node; compare browser HTTPS Origin with Host, never forwarded-host. */
export function trustedMutationOrigin(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return false;
  }
  const originHeader = request.headers.get("origin");
  if (!originHeader || originHeader === "null") {
    return false;
  }
  try {
    const origin = new URL(originHeader);
    if (origin.origin !== originHeader || origin.username || origin.password) {
      return false;
    }
    const host = request.headers.get("host") ?? new URL(request.url).host;
    if (origin.host !== host.toLowerCase()) {
      return false;
    }
    return (
      origin.protocol === "https:" ||
      (origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
    );
  } catch {
    return false;
  }
}

function error(message: string, status: number, extraHeaders: Record<string, string> = {}) {
  return Response.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store", ...extraHeaders } }
  );
}

type LoginOptions = {
  env?: AuthEnvironment;
  now?: () => number;
  guard?: Pick<typeof loginGuard, "attempt">;
};

export async function handleLogin(
  request: Request,
  { env = process.env, now = Date.now, guard = loginGuard }: LoginOptions = {}
) {
  // Count successful, malformed, and unsuccessful attempts equally. No untrusted IP headers.
  const attempt = guard.attempt();
  if (!attempt.allowed) {
    return error("Too many login attempts. Please try again later.", 429, {
      "Retry-After": String(attempt.retryAfter),
    });
  }
  if (!trustedMutationOrigin(request)) {
    return error("A same-origin request is required.", 403);
  }
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
  ) {
    return error("Send the request as application/json.", 415);
  }
  const reader = request.body?.getReader();
  if (!reader) {
    return error("A JSON request body is required.", 400);
  }
  const abort = AbortSignal.any([request.signal, AbortSignal.timeout(LOGIN_BODY_TIMEOUT_MS)]);
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  abort.addEventListener("abort", cancel, { once: true });
  let body: unknown;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      if (abort.aborted) {
        return error("The login request timed out.", 408);
      }
      const { done, value } = await reader.read();
      if (abort.aborted) {
        return error("The login request timed out.", 408);
      }
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_LOGIN_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        return error("The login request is too large.", 413);
      }
      chunks.push(value);
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return error("The request must contain valid JSON.", 400);
  } finally {
    abort.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const password =
    body && typeof body === "object" && "password" in body ? body.password : undefined;
  if (typeof password !== "string" || Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    return error("A valid password is required.", 400);
  }
  const config = authConfig(env);
  if (!config) {
    return error("Login is not configured. Contact the organizer.", 503);
  }
  const candidate = createHash("sha256").update(password, "utf8").digest();
  if (!timingSafeEqual(candidate, config.passwordHash)) {
    return error("Incorrect password.", 401);
  }
  const token = createSessionToken(env, now());
  if (!token) {
    return error("Login is temporarily unavailable.", 503);
  }
  return Response.json(
    { authenticated: true },
    {
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": `${SESSION_COOKIE_NAME}=${token}; Max-Age=${SESSION_MAX_AGE_SECONDS}; ${COOKIE_ATTRIBUTES}`,
      },
    }
  );
}

export function handleLogout(request: Request) {
  if (!trustedMutationOrigin(request)) {
    return error("A same-origin request is required.", 403);
  }
  return Response.json(
    { authenticated: false },
    {
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": `${SESSION_COOKIE_NAME}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${COOKIE_ATTRIBUTES}`,
      },
    }
  );
}
