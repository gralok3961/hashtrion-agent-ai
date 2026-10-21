import { signUcpRequest, UcpSigningError, type SigningRequest } from "./ucp-signature";
import { lookup } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import type { LookupAddress } from "node:dns";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { isIP, type LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";

const TIMEOUT_MS = 6_000;
const ISSUE_CREDENTIAL_TIMEOUT_MS = 15_000;
const COMPLETE_CHECKOUT_TIMEOUT_MS = 45_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_REQUEST_BYTES = 32 * 1024;

export type UcpRequestHeaders = {
  "Request-Id": string;
  "UCP-Agent": string;
  "Idempotency-Key"?: string;
};

export type PublicJsonResponse = { body: unknown; url: string; status: number };
export type UcpRequestPolicy = {
  requireSignature?: boolean;
  discardErrorBody?: boolean;
  timeoutPolicy?: "complete_checkout" | "issue_credential";
};

export type SafeFetchErrorCode =
  | "signing_not_configured"
  | "signing_invalid_configuration"
  | "unsafe_url"
  | "timeout"
  | "too_large"
  | "not_found"
  | "http_error"
  | "invalid_request"
  | "invalid_json"
  | "network_error";

const ERROR_MESSAGES: Record<SafeFetchErrorCode, string> = {
  signing_not_configured: "UCP request signing is not configured on the server.",
  signing_invalid_configuration: "UCP request signing configuration is invalid.",
  unsafe_url: "The destination is not an allowed public HTTPS URL.",
  timeout: "The external request timed out.",
  too_large: "The external request or response exceeded the size limit.",
  not_found: "No discovery profile was found.",
  http_error: "The external endpoint did not return a supported response.",
  invalid_request: "The external request could not be safely encoded.",
  invalid_json: "The external endpoint did not return valid JSON.",
  network_error: "The external endpoint could not be reached.",
};

export class SafeFetchError extends Error {
  constructor(public readonly code: SafeFetchErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "SafeFetchError";
  }
}

function isPublicAddress(address: string): boolean {
  if (!isIP(address)) {
    return false;
  }
  // Azure's platform virtual IP is globally shaped but reaches host infrastructure.
  if (address === "168.63.129.16") {
    return false;
  }
  const parsed = ipaddr.parse(address);
  // Deny special-use, mapped IPv4, private, loopback, multicast and transition ranges.
  if (parsed.range() !== "unicast") {
    return false;
  }
  if (parsed.kind() === "ipv6") {
    const ipv6 = parsed as ipaddr.IPv6;
    // Conservative allowlist: currently allocated global unicast, minus protocol
    // assignments and documentation blocks (including newer allocations).
    return (
      ipv6.match(ipaddr.parse("2000::") as ipaddr.IPv6, 3) &&
      !ipv6.match(ipaddr.parse("2001::") as ipaddr.IPv6, 23) &&
      !ipv6.match(ipaddr.parse("2001:db8::") as ipaddr.IPv6, 32) &&
      !ipv6.match(ipaddr.parse("3fff::") as ipaddr.IPv6, 20)
    );
  }
  return true;
}

function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

/** Validate syntax and literal IPs; a domain still requires DNS validation. */
export function safePublicUrl(raw: string): URL {
  if (
    typeof raw !== "string" ||
    raw.length > 2_048 ||
    /[\s\\]/u.test(raw) ||
    [...raw].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    throw new SafeFetchError("unsafe_url");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError("unsafe_url");
  }
  if (
    url.protocol !== "https:" ||
    (url.port && url.port !== "443") ||
    url.username ||
    url.password ||
    raw.includes("#") ||
    raw
      .slice(raw.indexOf("//") + 2)
      .split("/")[0]
      .includes("@")
  ) {
    throw new SafeFetchError("unsafe_url");
  }
  const hostname = hostnameOf(url);
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) {
      throw new SafeFetchError("unsafe_url");
    }
  } else if (
    hostname.length > 253 ||
    !hostname.includes(".") ||
    hostname.endsWith(".") ||
    hostname.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
    /(?:^|\.)(?:localhost|local|internal|invalid|test)$/i.test(hostname)
  ) {
    throw new SafeFetchError("unsafe_url");
  }
  return url;
}

type SafeHttpDependencies = {
  resolve: (hostname: string) => Promise<LookupAddress[]>;
  request: (
    options: RequestOptions,
    callback: (response: IncomingMessage) => void
  ) => ClientRequest;
  sign?: (request: SigningRequest) => Promise<Record<string, string>>;
  timeoutMs?: number;
  completeCheckoutTimeoutMs?: number;
  maxBytes?: number;
  maxRequestBytes?: number;
};

function abortedError(signal: AbortSignal): SafeFetchError {
  return signal.reason instanceof SafeFetchError
    ? signal.reason
    : new SafeFetchError("network_error");
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortedError(signal));
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
    }
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Explicit injection is for deterministic tests; exported production functions use Node HTTPS. */
export function createSafeHttpClient(dependencies: SafeHttpDependencies) {
  const timeoutMs = dependencies.timeoutMs ?? TIMEOUT_MS;
  const completeCheckoutTimeoutMs =
    dependencies.completeCheckoutTimeoutMs ?? COMPLETE_CHECKOUT_TIMEOUT_MS;
  const maxBytes = dependencies.maxBytes ?? MAX_RESPONSE_BYTES;
  const maxRequestBytes = dependencies.maxRequestBytes ?? MAX_REQUEST_BYTES;

  async function withDeadline<T>(
    action: (signal: AbortSignal) => Promise<T>,
    externalSignal?: AbortSignal,
    deadlineMs = timeoutMs
  ): Promise<T> {
    const controller = new AbortController();
    const cancel = () => controller.abort(new SafeFetchError("network_error"));
    if (externalSignal?.aborted) {
      cancel();
    } else {
      externalSignal?.addEventListener("abort", cancel, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new SafeFetchError("timeout")), deadlineMs);
    try {
      if (controller.signal.aborted) {
        throw abortedError(controller.signal);
      }
      return await action(controller.signal);
    } catch (error) {
      throw error instanceof SafeFetchError ? error : new SafeFetchError("network_error");
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", cancel);
    }
  }

  async function resolvePublic(url: URL, signal: AbortSignal): Promise<LookupAddress[]> {
    const hostname = hostnameOf(url);
    const family = isIP(hostname);
    const addresses = family
      ? [{ address: hostname, family }]
      : await abortable(dependencies.resolve(hostname), signal);
    if (
      addresses.length === 0 ||
      addresses.length > 64 ||
      addresses.some(({ address, family }) => isIP(address) !== family || !isPublicAddress(address))
    ) {
      throw new SafeFetchError("unsafe_url");
    }
    return addresses;
  }

  async function assertPublicDestination(url: URL, signal?: AbortSignal): Promise<void> {
    const checked = safePublicUrl(url.href);
    await withDeadline(async (innerSignal) => {
      await resolvePublic(checked, innerSignal);
    }, signal);
  }

  async function requestPublicJson(
    url: URL,
    method: "GET" | "POST" | "PUT",
    requestBody?: Buffer,
    headers?: UcpRequestHeaders,
    signal?: AbortSignal,
    policy: UcpRequestPolicy = {}
  ): Promise<PublicJsonResponse> {
    // Only explicitly selected credential and Complete POSTs get longer budgets. All DNS,
    // signing, connection and response-body work still shares one deadline.
    const deadlineMs =
      policy.timeoutPolicy === "complete_checkout" &&
      method === "POST" &&
      /\/checkout-sessions\/[^/]+\/complete$/.test(url.pathname)
        ? completeCheckoutTimeoutMs
        : policy.timeoutPolicy === "issue_credential" &&
            method === "POST" &&
            url.pathname === "/api/UcpPayment/issue-credential"
          ? ISSUE_CREDENTIAL_TIMEOUT_MS
          : timeoutMs;
    return withDeadline(
      async (innerSignal) => {
        let signatureHeaders: Record<string, string> = {};
        if (policy.requireSignature && (!headers || !dependencies.sign)) {
          throw new SafeFetchError("signing_not_configured");
        }
        if (headers && dependencies.sign) {
          try {
            signatureHeaders = await dependencies.sign({
              url,
              method,
              body: requestBody,
              headers: {
                ...headers,
                ...(requestBody ? { "Content-Type": "application/json" } : {}),
              },
              required: policy.requireSignature || /\/checkout-sessions(?:\/|$)/.test(url.pathname),
            });
          } catch (error) {
            if (error instanceof UcpSigningError) {
              throw new SafeFetchError(error.code);
            }
            throw new SafeFetchError("signing_invalid_configuration");
          }
        }
        const addresses = await resolvePublic(url, innerSignal);
        if (innerSignal.aborted) {
          throw abortedError(innerSignal);
        }
        // The HTTPS request never performs a second DNS lookup. Keep the URL hostname
        // for the Host header, SNI and Node's default TLS certificate verification.
        const pinned = addresses[0];
        const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
          if (options.all) {
            callback(null, [pinned]);
          } else {
            callback(null, pinned.address, pinned.family);
          }
        };
        return new Promise<PublicJsonResponse>((resolve, reject) => {
          let req: ClientRequest | undefined;
          let response: IncomingMessage | undefined;
          let settled = false;
          const finish = (error?: SafeFetchError, body?: unknown) => {
            if (settled) {
              return;
            }
            settled = true;
            innerSignal.removeEventListener("abort", onAbort);
            if (error) {
              response?.destroy();
              req?.destroy();
              reject(error);
            } else {
              resolve({ body, url: url.href, status: response!.statusCode! });
            }
          };
          const onAbort = () => finish(abortedError(innerSignal));
          innerSignal.addEventListener("abort", onAbort, { once: true });
          try {
            req = dependencies.request(
              {
                protocol: "https:",
                hostname: hostnameOf(url),
                port: 443,
                path: `${url.pathname}${url.search}`,
                method,
                agent: false,
                lookup: pinnedLookup,
                rejectUnauthorized: true,
                ...(headers && (headers["Idempotency-Key"] || method === "GET")
                  ? { minVersion: "TLSv1.3" as const }
                  : {}),
                ...(isIP(hostnameOf(url)) ? {} : { servername: hostnameOf(url) }),
                headers: {
                  ...signatureHeaders,
                  Accept: "application/json",
                  "Accept-Encoding": "identity",
                  ...(requestBody
                    ? {
                        "Content-Type": "application/json",
                        "Content-Length": requestBody.length,
                      }
                    : {}),
                  ...(headers
                    ? {
                        // Copy known fields explicitly; never forward cookies, tokens, or
                        // arbitrary runtime properties supplied by a caller.
                        "Request-Id": headers!["Request-Id"],
                        "UCP-Agent": headers["UCP-Agent"],
                        ...(headers["Idempotency-Key"]
                          ? { "Idempotency-Key": headers["Idempotency-Key"] }
                          : {}),
                      }
                    : {}),
                },
                signal: innerSignal,
              },
              (res) => {
                response = res;
                res.on("error", () => finish(new SafeFetchError("network_error")));
                res.on("aborted", () => finish(new SafeFetchError("network_error")));
                if (settled) {
                  res.destroy();
                  return;
                }
                const status = res.statusCode ?? 0;
                if (status >= 300 && status < 400) {
                  finish(new SafeFetchError("unsafe_url"));
                  return;
                }
                if (method === "GET" && (status === 404 || status === 410)) {
                  finish(new SafeFetchError("not_found"));
                  return;
                }
                if (method === "GET" ? status !== 200 : status < 200 || status > 599) {
                  finish(new SafeFetchError("http_error"));
                  return;
                }
                if (policy.discardErrorBody && status >= 400) {
                  finish();
                  res.destroy();
                  return;
                }
                const encoding = res.headers["content-encoding"];
                const contentType =
                  res.headers["content-type"]?.split(";")[0].trim().toLowerCase() ?? "";
                if (
                  (encoding && encoding.toLowerCase() !== "identity") ||
                  !/^application\/(?:[\w.+-]+\+)?json$/.test(contentType)
                ) {
                  finish(new SafeFetchError("http_error"));
                  return;
                }
                const contentLength = res.headers["content-length"];
                if (
                  contentLength &&
                  (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)
                ) {
                  finish(
                    new SafeFetchError(/^\d+$/.test(contentLength) ? "too_large" : "http_error")
                  );
                  return;
                }
                let bytes = 0;
                const chunks: Buffer[] = [];
                res.on("data", (chunk: Buffer) => {
                  if (settled) {
                    return;
                  }
                  bytes += chunk.length;
                  if (bytes > maxBytes) {
                    finish(new SafeFetchError("too_large"));
                    return;
                  }
                  chunks.push(chunk);
                });
                res.on("end", () => {
                  if (settled) {
                    return;
                  }
                  try {
                    const text = new TextDecoder("utf-8", { fatal: true }).decode(
                      Buffer.concat(chunks)
                    );
                    finish(undefined, JSON.parse(text));
                  } catch {
                    finish(new SafeFetchError("invalid_json"));
                  }
                });
              }
            );
            req.on("error", () =>
              finish(
                innerSignal.aborted
                  ? abortedError(innerSignal)
                  : new SafeFetchError("network_error")
              )
            );
            if (requestBody) {
              req.end(requestBody);
            } else {
              req.end();
            }
          } catch {
            finish(new SafeFetchError("network_error"));
          }
        });
      },
      signal,
      deadlineMs
    );
  }

  async function fetchPublicJson(
    raw: string,
    signal?: AbortSignal
  ): Promise<{ body: unknown; url: string }> {
    const { body, url } = await requestPublicJson(
      safePublicUrl(raw),
      "GET",
      undefined,
      undefined,
      signal
    );
    return { body, url };
  }

  async function requestUcpJson(
    raw: string,
    method: "GET" | "POST" | "PUT",
    body: unknown,
    headers: UcpRequestHeaders,
    signal?: AbortSignal,
    policy: UcpRequestPolicy = {}
  ): Promise<PublicJsonResponse> {
    const url = safePublicUrl(raw);
    if (!["GET", "POST", "PUT"].includes(method)) {
      throw new SafeFetchError("invalid_request");
    }
    // This client only sends the public platform-profile identity defined by UCP,
    // not arbitrary agent header parameters or credentials.
    if (
      !headers ||
      typeof headers["Request-Id"] !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(headers["Request-Id"]) ||
      typeof headers["UCP-Agent"] !== "string" ||
      headers["UCP-Agent"].length > 2_048
    ) {
      throw new SafeFetchError("invalid_request");
    }
    const profile = /^profile="([^"\r\n]+)"$/.exec(headers["UCP-Agent"]);
    if (!profile) {
      throw new SafeFetchError("invalid_request");
    }
    const profileUrl = safePublicUrl(profile[1]);
    if (profileUrl.search) {
      throw new SafeFetchError("invalid_request");
    }
    if (
      headers["Idempotency-Key"] !== undefined &&
      !/^[A-Za-z0-9_-]{22,128}$/.test(headers["Idempotency-Key"])
    ) {
      throw new SafeFetchError("invalid_request");
    }
    headers = {
      "Request-Id": headers["Request-Id"],
      "UCP-Agent": headers["UCP-Agent"],
      ...(headers["Idempotency-Key"]
        ? { "Idempotency-Key": headers["Idempotency-Key"] }
        : method !== "GET"
          ? { "Idempotency-Key": randomUUID() }
          : {}),
    };
    if (method === "GET") {
      return requestPublicJson(url, "GET", undefined, headers, signal, policy);
    }
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(body);
    } catch {
      throw new SafeFetchError("invalid_request");
    }
    if (serialized === undefined) {
      throw new SafeFetchError("invalid_request");
    }
    if (Buffer.byteLength(serialized, "utf8") > maxRequestBytes) {
      throw new SafeFetchError("too_large");
    }
    return requestPublicJson(url, method, Buffer.from(serialized, "utf8"), headers, signal, policy);
  }

  const postPublicJson = (
    raw: string,
    body: unknown,
    headers: UcpRequestHeaders,
    signal?: AbortSignal
  ) => requestUcpJson(raw, "POST", body, headers, signal);

  /** A credential-free, endpoint-bound fetch implementation for the MCP SDK. */
  function createMcpFetch(
    endpoint: string,
    publicProfileUrl: string,
    signal: AbortSignal
  ): typeof fetch {
    const url = safePublicUrl(endpoint);
    const profile = safePublicUrl(publicProfileUrl);
    if (url.search || profile.search) {
      throw new SafeFetchError("unsafe_url");
    }
    const sessionPattern = /^[\x21-\x7e]{1,256}$/;
    const versionPattern = /^\d{4}-\d{2}-\d{2}$/;

    return async (input, init) => {
      const incoming = input instanceof Request ? input : undefined;
      const target = safePublicUrl(incoming?.url ?? String(input));
      if (target.href !== url.href) {
        throw new SafeFetchError("unsafe_url");
      }
      const method = (init?.method ?? incoming?.method ?? "GET").toUpperCase();
      // This client only performs bounded request/response exchanges. The SDK's
      // optional background SSE connection and session deletion never reach I/O.
      if (method === "GET" || method === "DELETE") {
        return new Response(null, { status: 405 });
      }
      if (method !== "POST" || typeof init?.body !== "string") {
        throw new SafeFetchError("invalid_request");
      }
      const requestBody = Buffer.from(init.body, "utf8");
      if (requestBody.length > maxRequestBytes) {
        throw new SafeFetchError("too_large");
      }
      let requestMessage: Record<string, unknown>;
      let suppliedHeaders: Headers;
      try {
        const value: unknown = JSON.parse(init.body);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error();
        }
        requestMessage = value as Record<string, unknown>;
        if (
          requestMessage.jsonrpc !== "2.0" ||
          typeof requestMessage.method !== "string" ||
          !requestMessage.method.length ||
          requestMessage.method.length > 128 ||
          (requestMessage.id !== undefined &&
            !(typeof requestMessage.id === "number" && Number.isSafeInteger(requestMessage.id)) &&
            !(
              typeof requestMessage.id === "string" &&
              requestMessage.id.length > 0 &&
              requestMessage.id.length <= 128
            ))
        ) {
          throw new Error();
        }
        suppliedHeaders = new Headers(init.headers ?? incoming?.headers);
      } catch {
        throw new SafeFetchError("invalid_request");
      }
      const session = suppliedHeaders.get("mcp-session-id");
      const version = suppliedHeaders.get("mcp-protocol-version");
      if (
        (session !== null && !sessionPattern.test(session)) ||
        (version !== null && !versionPattern.test(version))
      ) {
        throw new SafeFetchError("invalid_request");
      }
      const requestSignal = init.signal ?? incoming?.signal;
      const combinedSignal = requestSignal ? AbortSignal.any([signal, requestSignal]) : signal;
      return withDeadline(async (innerSignal) => {
        const addresses = await resolvePublic(url, innerSignal);
        if (innerSignal.aborted) {
          throw abortedError(innerSignal);
        }
        const pinned = addresses[0];
        const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
          if (options.all) {
            callback(null, [pinned]);
          } else {
            callback(null, pinned.address, pinned.family);
          }
        };
        return new Promise<Response>((resolve, reject) => {
          let req: ClientRequest | undefined;
          let response: IncomingMessage | undefined;
          let settled = false;
          const responseHeaders = new Headers();
          const finish = (
            error?: SafeFetchError,
            body: string | null = null,
            status = 200,
            stopStream = false
          ) => {
            if (settled) {
              return;
            }
            settled = true;
            innerSignal.removeEventListener("abort", onAbort);
            if (error || stopStream) {
              response?.destroy();
              req?.destroy();
            }
            if (error) {
              reject(error);
            } else {
              resolve(new Response(body, { status, headers: responseHeaders }));
            }
          };
          const onAbort = () => finish(abortedError(innerSignal));
          innerSignal.addEventListener("abort", onAbort, { once: true });
          const matchesResponse = (value: unknown) => {
            if (
              !value ||
              typeof value !== "object" ||
              Array.isArray(value) ||
              requestMessage.id === undefined
            ) {
              return false;
            }
            const message = value as Record<string, unknown>;
            return (
              message.jsonrpc === "2.0" &&
              message.id === requestMessage.id &&
              (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))
            );
          };
          try {
            req = dependencies.request(
              {
                protocol: "https:",
                hostname: hostnameOf(url),
                port: 443,
                path: url.pathname,
                method: "POST",
                agent: false,
                lookup: pinnedLookup,
                rejectUnauthorized: true,
                ...(isIP(hostnameOf(url)) ? {} : { servername: hostnameOf(url) }),
                headers: {
                  Accept: "application/json, text/event-stream",
                  "Accept-Encoding": "identity",
                  "Content-Type": "application/json",
                  "Content-Length": requestBody.length,
                  "Request-Id": randomUUID(),
                  "UCP-Agent": `profile="${profile.href}"`,
                  ...(session === null ? {} : { "Mcp-Session-Id": session }),
                  ...(version === null ? {} : { "Mcp-Protocol-Version": version }),
                },
                signal: innerSignal,
              },
              (res) => {
                response = res;
                res.on("error", () => finish(new SafeFetchError("network_error")));
                res.on("aborted", () => finish(new SafeFetchError("network_error")));
                if (settled) {
                  res.destroy();
                  return;
                }
                const status = res.statusCode ?? 0;
                if (status >= 300 && status < 400) {
                  finish(new SafeFetchError("unsafe_url"));
                  return;
                }
                // In particular, never return 401 to the SDK's OAuth retry path.
                if (status !== 200 && status !== 202) {
                  finish(new SafeFetchError("http_error"));
                  return;
                }
                const sessionId = res.headers["mcp-session-id"];
                if (sessionId !== undefined) {
                  if (typeof sessionId !== "string" || !sessionPattern.test(sessionId)) {
                    finish(new SafeFetchError("http_error"));
                    return;
                  }
                  responseHeaders.set("mcp-session-id", sessionId);
                }
                if (status === 202) {
                  if (requestMessage.id !== undefined) {
                    finish(new SafeFetchError("http_error"));
                    return;
                  }
                  finish(undefined, null, 202, true);
                  return;
                }
                const encoding = res.headers["content-encoding"];
                const contentType =
                  res.headers["content-type"]?.split(";")[0].trim().toLowerCase() ?? "";
                const sse = contentType === "text/event-stream";
                if (
                  (encoding && encoding.toLowerCase() !== "identity") ||
                  (!sse && !/^application\/(?:[\w.+-]+\+)?json$/.test(contentType))
                ) {
                  finish(new SafeFetchError("http_error"));
                  return;
                }
                responseHeaders.set("content-type", contentType);
                const contentLength = res.headers["content-length"];
                if (
                  contentLength &&
                  (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)
                ) {
                  finish(
                    new SafeFetchError(/^\d+$/.test(contentLength) ? "too_large" : "http_error")
                  );
                  return;
                }
                let bytes = 0;
                let text = "";
                let pendingLines = "";
                let eventName = "";
                let eventData: string[] = [];
                const decoder = new TextDecoder("utf-8", { fatal: true });
                const consumeLine = (line: string) => {
                  if (line === "") {
                    if (eventData.length && (!eventName || eventName === "message")) {
                      const data = eventData.join("\n");
                      const value: unknown = JSON.parse(data);
                      if (matchesResponse(value)) {
                        // Return only the matching response, never unsolicited
                        // server requests or reconnect instructions from the stream.
                        finish(
                          undefined,
                          `event: message\ndata: ${JSON.stringify(value)}\n\n`,
                          200,
                          true
                        );
                      }
                    }
                    eventName = "";
                    eventData = [];
                  } else if (!line.startsWith(":")) {
                    const colon = line.indexOf(":");
                    const field = colon === -1 ? line : line.slice(0, colon);
                    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
                    if (field === "data") {
                      eventData.push(value);
                    }
                    if (field === "event") {
                      eventName = value;
                    }
                  }
                };
                const consumeText = (chunk: string, final = false) => {
                  if (!sse) {
                    text += chunk;
                    return;
                  }
                  pendingLines += chunk;
                  while (!settled) {
                    const index = pendingLines.search(/[\r\n]/);
                    if (
                      index === -1 ||
                      (!final && index === pendingLines.length - 1 && pendingLines[index] === "\r")
                    ) {
                      break;
                    }
                    const length =
                      pendingLines[index] === "\r" && pendingLines[index + 1] === "\n" ? 2 : 1;
                    const line = pendingLines.slice(0, index);
                    pendingLines = pendingLines.slice(index + length);
                    consumeLine(line);
                  }
                };
                res.on("data", (chunk: Buffer) => {
                  if (settled) {
                    return;
                  }
                  bytes += chunk.length;
                  if (bytes > maxBytes) {
                    finish(new SafeFetchError("too_large"));
                    return;
                  }
                  try {
                    consumeText(decoder.decode(chunk, { stream: true }));
                  } catch {
                    finish(new SafeFetchError("invalid_json"));
                  }
                });
                res.on("end", () => {
                  if (settled) {
                    return;
                  }
                  try {
                    consumeText(decoder.decode(), true);
                    if (settled) {
                      return;
                    }
                    if (sse) {
                      finish(new SafeFetchError("invalid_json"));
                      return;
                    }
                    const empty = /^[\t\n\r ]*$/.test(text);
                    const value: unknown = empty ? undefined : JSON.parse(text);
                    // Some MCP servers acknowledge initialized with HTTP 200 and
                    // JSON null (or no content), instead of the required empty 202.
                    // Normalize only this notification; never accept missing RPC
                    // results, unsolicited messages, or arbitrary acknowledgments.
                    if (
                      requestMessage.method === "notifications/initialized" &&
                      !Object.hasOwn(requestMessage, "id") &&
                      contentType === "application/json" &&
                      (empty || value === null)
                    ) {
                      responseHeaders.delete("content-type");
                      finish(undefined, null, 202);
                      return;
                    }
                    if (!matchesResponse(value)) {
                      finish(new SafeFetchError("invalid_json"));
                      return;
                    }
                    finish(undefined, text);
                  } catch {
                    finish(new SafeFetchError("invalid_json"));
                  }
                });
              }
            );
            req.on("error", () =>
              finish(
                innerSignal.aborted
                  ? abortedError(innerSignal)
                  : new SafeFetchError("network_error")
              )
            );
            req.end(requestBody);
          } catch {
            finish(new SafeFetchError("network_error"));
          }
        });
      }, combinedSignal);
    };
  }

  return {
    assertPublicDestination,
    fetchPublicJson,
    postPublicJson,
    requestUcpJson,
    createMcpFetch,
  };
}

const client = createSafeHttpClient({
  resolve: (hostname) => lookup(hostname, { all: true, verbatim: true }),
  request: httpsRequest,
  sign: signUcpRequest,
});

export const assertPublicDestination = client.assertPublicDestination;
export const fetchPublicJson = client.fetchPublicJson;
export const postPublicJson = client.postPublicJson;
export const createMcpFetch = client.createMcpFetch;

export const requestUcpJson = client.requestUcpJson;
