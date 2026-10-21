import { randomUUID } from "node:crypto";
import { isAgentId } from "@/lib/agent-id";
import { authenticateRequest, trustedMutationOrigin } from "@/lib/server/auth";
import { requestUcpJson, safePublicUrl } from "@/lib/server/safe-http";

export const runtime = "nodejs";

function error(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!authenticateRequest(request)) {
    return error("Please sign in to save your Agent ID.", 401);
  }
  if (!trustedMutationOrigin(request)) {
    return error("This request is not allowed.", 403);
  }
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return error("Send the request as application/json.", 415);
  }
  const reader = request.body?.getReader();
  if (!reader) {
    return error("An Agent ID is required.", 400);
  }
  const bodySignal = AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]);
  const cancel = () => { void reader.cancel().catch(() => {}); };
  bodySignal.addEventListener("abort", cancel, { once: true });
  let body: unknown;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      if (bodySignal.aborted) return error("The request timed out.", 408);
      const { done, value } = await reader.read();
      if (bodySignal.aborted) return error("The request timed out.", 408);
      if (done) break;
      size += value.byteLength;
      if (size > 1_024) {
        cancel();
        return error("The request is too large.", 413);
      }
      chunks.push(value);
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return error("Send a valid Agent ID.", 400);
  } finally {
    bodySignal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      !("agentId" in body) || !isAgentId(body.agentId) ||
      Object.keys(body).some((key) => key !== "agentId")) {
    return error("Send a valid Agent ID.", 400);
  }
  try {
    const base = safePublicUrl(process.env.CONNECTION_API_BASE_URL ?? "");
    if (base.search || !["/", "/api", "/api/"].includes(base.pathname)) {
      throw new Error();
    }
    const endpoint = new URL("/api/AppClientAuth/mock/agent-platform-connection", base);
    const response = await requestUcpJson(
      endpoint.href,
      "POST",
      { agentId: body.agentId },
      {
        "Request-Id": randomUUID(),
        "UCP-Agent": `profile="${process.env.UCP_PLATFORM_PROFILE_URL ?? ""}"`,
      },
      request.signal,
      { discardErrorBody: true }
    );
    if (response.status !== 200 || response.body !== true) {
      throw new Error();
    }
    return Response.json(true, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return error("Unable to save Agent ID. Please try again.", 502);
  }
}
