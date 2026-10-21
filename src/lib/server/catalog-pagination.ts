import { shoppingStore, shoppingOwner } from "./shopping-state";
import { mergeCatalogPage } from "../catalog-display";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { CatalogFilters, CatalogReport } from "../catalog-types";
import { authenticateRequest, trustedMutationOrigin, type AuthEnvironment } from "./auth";
import { catalogSearch, validCatalogSearch } from "./catalog";
import { providerCatalogSearch } from "./catalog-provider";
import { getCatalogProvider, type CatalogProvider } from "./catalog-provider-registry";
import { discoverRequestedMerchant } from "./merchant-target";
import { verifyCandidates } from "./discovery";
import { safePublicUrl } from "./safe-http";
import { acquireChatSlot, discoveryEnabled } from "./usage-guard";

const TOKEN_MAX_LENGTH = 8_192;
const TOKEN_LIFETIME_MS = 30 * 60_000;
const BODY_MAX_BYTES = 12_288;
type Continuation = {
  domain: string;
  query: string;
  cursor: string;
  provider?: CatalogProvider["id"];
  filters?: CatalogFilters;
  context?: { currency: string };
  expires: number;
};
function signingSecret(secret: string | undefined): secret is string {
  return (
    typeof secret === "string" &&
    Buffer.byteLength(secret, "utf8") >= 32 &&
    Buffer.byteLength(secret, "utf8") <= 4_096
  );
}
function signature(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update("hashtrion-catalog-page:v1\0")
    .update(payload)
    .digest();
}
function validContinuation(value: unknown): value is Continuation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (key) =>
        !["domain", "query", "cursor", "filters", "context", "expires", "provider"].includes(key)
    ) ||
    typeof v.domain !== "string" ||
    typeof v.cursor !== "string" ||
    !v.cursor.length ||
    v.cursor.length > 2_048 ||
    typeof v.expires !== "number" ||
    !Number.isSafeInteger(v.expires) ||
    !validCatalogSearch(v.query, v.filters, v.context)
  ) {
    return false;
  }
  if (v.provider !== undefined) {
    if (typeof v.provider !== "string") {
      return false;
    }
    const provider = getCatalogProvider(v.provider);
    if (!provider || v.domain !== new URL(provider.endpoint).hostname) {
      return false;
    }
  }
  try {
    const url = safePublicUrl(`https://${v.domain}`);
    return url.hostname === v.domain && url.pathname === "/" && !url.search;
  } catch {
    return false;
  }
}

/** Mint only from verified catalog output. No endpoint or client-provided destination is accepted. */
export function withCatalogContinuation(
  report: CatalogReport,
  secret: string | undefined = process.env.AGENT_AI_SESSION_SECRET,
  now = Date.now()
): CatalogReport {
  // Do not propagate a stale token if a new result has no additional page.
  const clean = { ...report };
  delete clean.continuation;
  if (
    report.status !== "completed" ||
    !report.pagination?.hasNextPage ||
    !report.pagination.cursor ||
    !signingSecret(secret) ||
    !Number.isSafeInteger(now)
  ) {
    return clean;
  }
  const data: Continuation = {
    domain: report.merchantDomain,
    query: report.query,
    cursor: report.pagination.cursor,
    ...(report.provider ? { provider: report.provider } : {}),
    ...(report.filters ? { filters: report.filters } : {}),
    ...(report.context ? { context: report.context } : {}),
    expires: now + TOKEN_LIFETIME_MS,
  };
  if (!validContinuation(data)) {
    return clean;
  }
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  const token = `v1.${payload}.${signature(payload, secret).toString("base64url")}`;
  return token.length <= TOKEN_MAX_LENGTH ? { ...clean, continuation: token } : clean;
}

export function readCatalogContinuation(
  token: unknown,
  secret: string | undefined,
  now = Date.now()
): Continuation | null {
  if (
    typeof token !== "string" ||
    token.length > TOKEN_MAX_LENGTH ||
    !signingSecret(secret) ||
    !Number.isSafeInteger(now)
  ) {
    return null;
  }
  const match = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) {
    return null;
  }
  const actual = Buffer.from(match[2], "base64url"),
    expected = signature(match[1], secret);
  if (
    actual.length !== expected.length ||
    actual.toString("base64url") !== match[2] ||
    !timingSafeEqual(actual, expected)
  ) {
    return null;
  }
  try {
    const decoded = Buffer.from(match[1], "base64url");
    if (decoded.toString("base64url") !== match[1]) {
      return null;
    }
    const value: unknown = JSON.parse(decoded.toString("utf8"));
    if (
      !validContinuation(value) ||
      value.expires <= now ||
      value.expires > now + TOKEN_LIFETIME_MS
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function error(message: string, status: number, headers: Record<string, string> = {}) {
  return Response.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store", ...headers } }
  );
}
type PageOptions = {
  env?: AuthEnvironment;
  now?: () => number;
  acquire?: typeof acquireChatSlot;
  verify?: typeof verifyCandidates;
  catalog?: typeof catalogSearch;
  providerCatalog?: typeof providerCatalogSearch;
  providerLookup?: typeof getCatalogProvider;
};

export async function handleCatalogPage(
  request: Request,
  options: PageOptions = {}
): Promise<Response> {
  const env = options.env ?? process.env,
    now = options.now ?? Date.now;
  // Same authentication boundary and shared quota as chat, before any network I/O.
  if (!authenticateRequest(request, env, now())) {
    return error("Please sign in to see more products.", 401);
  }
  if (!trustedMutationOrigin(request)) {
    return error("This request is not allowed.", 403);
  }
  if (!discoveryEnabled(env)) {
    return error("Product search is disabled on this server.", 403);
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
  const bodySignal = AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]);
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  bodySignal.addEventListener("abort", cancel, { once: true });
  let body: unknown;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      if (bodySignal.aborted) {
        return error("The request timed out.", 408);
      }
      const { done, value } = await reader.read();
      if (bodySignal.aborted) {
        return error("The request timed out.", 408);
      }
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > BODY_MAX_BYTES) {
        cancel();
        return error("The request is too large.", 413);
      }
      chunks.push(value);
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return error("The request must contain valid JSON.", 400);
  } finally {
    bodySignal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => !["continuation", "conversationId"].includes(k)) ||
    !("continuation" in body)
  ) {
    return error("A valid product continuation is required.", 400);
  }
  const conversationId = "conversationId" in body ? body.conversationId : undefined;
  if (
    conversationId !== undefined &&
    (typeof conversationId !== "string" || !/^[0-9a-f-]{36}$/.test(conversationId))
  ) {
    return error("Invalid shopping conversation.", 400);
  }
  const continuation = readCatalogContinuation(
    body.continuation,
    env.AGENT_AI_SESSION_SECRET,
    now()
  );
  if (!continuation) {
    return error("This product page has expired or is invalid. Search again.", 400);
  }
  const provider = continuation.provider
    ? (options.providerLookup ?? getCatalogProvider)(continuation.provider)
    : undefined;
  if (continuation.provider && provider?.id !== continuation.provider) {
    return error("This catalog provider is no longer enabled. Search again.", 403);
  }
  const release = (options.acquire ?? acquireChatSlot)();
  if (!release) {
    return error("Usage limit reached. Please try again later.", 429, { "Retry-After": "60" });
  }
  let shopping: ReturnType<typeof shoppingStore.acquire> | undefined;
  try {
    if (conversationId) {
      shopping = shoppingStore.acquire(shoppingOwner(request), conversationId);
      if (shopping.state.catalog?.continuation !== body.continuation) {
        return error("Only the current shopping results can be expanded. Search again.", 409);
      }
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
    const searchOptions = {
      signal,
      cursor: continuation.cursor,
      filters: continuation.filters,
      context: continuation.context,
      platformProfileUrl: env.UCP_PLATFORM_PROFILE_URL,
    };
    let catalog: CatalogReport;
    if (continuation.provider && provider) {
      catalog = await (options.providerCatalog ?? providerCatalogSearch)(
        provider,
        continuation.query,
        searchOptions
      );
    } else {
      const discovery = await discoverRequestedMerchant(
        continuation.domain,
        signal,
        options.verify
      );
      const merchant = discovery.merchants.find(
        (value) => value.status === "verified" && value.domain === continuation.domain
      );
      if (!merchant || merchant.status !== "verified") {
        return error("The merchant connection could not be verified. Please search again.", 502);
      }
      catalog = await (options.catalog ?? catalogSearch)(
        merchant,
        continuation.query,
        searchOptions
      );
    }
    // A repeated cursor is not progress; preserve metadata but do not offer a loop.
    const next = withCatalogContinuation(catalog, env.AGENT_AI_SESSION_SECRET, now());
    if (catalog.pagination?.cursor === continuation.cursor) {
      delete next.continuation;
    }
    if (shopping && next.status === "completed") {
      shopping.state.catalog = mergeCatalogPage(shopping.state.catalog!, next);
    }
    return Response.json({ catalog: next }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return error("Unable to load more products. Please try again later.", 502);
  } finally {
    shopping?.release();
    release();
  }
}
