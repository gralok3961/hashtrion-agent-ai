import { shoppingOwner, shoppingStore } from "@/lib/server/shopping-state";
import type { ShoppingAction } from "@/lib/shopping";
import OpenAI from "openai";
import { isChatHistory, MAX_REQUEST_BYTES } from "@/lib/chat";
import { isAgentId } from "@/lib/agent-id";

import { runChat } from "@/lib/server/chat-service";
import { acquireChatSlot, discoveryEnabled } from "@/lib/server/usage-guard";
import { authenticateRequest, trustedMutationOrigin } from "@/lib/server/auth";

export const runtime = "nodejs";

function error(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  // Gate the API itself, before reading the body, reserving quota, or calling OpenAI.
  if (!authenticateRequest(request)) {
    return error("Please sign in to use chat.", 401);
  }
  if (!trustedMutationOrigin(request)) {
    return error("This request is not allowed.", 403);
  }

  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    return error("Send the request as application/json.", 415);
  }

  // Bound the actual stream, including requests without Content-Length.
  const reader = request.body?.getReader();
  if (!reader) {
    return error("A JSON request body is required.", 400);
  }
  let body: unknown;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return error("The request is too large. Start a new chat.", 413);
      }
      chunks.push(value);
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return error("The request must contain valid JSON.", 400);
  } finally {
    reader.releaseLock();
  }

  const messages = body && typeof body === "object" && "messages" in body ? body.messages : null;
  if (!isChatHistory(messages) || messages.length === 0 || messages.at(-1)?.role !== "user") {
    return error(
      "Use alternating user and assistant messages ending with a user message. Limits: 40 messages, 12,000 characters per message, and 60,000 characters total.",
      400
    );
  }

  const agentId = body && typeof body === "object" && "agentId" in body ? body.agentId : undefined;
  if (agentId !== undefined && !isAgentId(agentId)) {
    return error("A valid Agent ID is required when supplied.", 400);
  }

  const fields = body as Record<string, unknown>;
  const conversationId = fields.conversationId;
  if (
    conversationId !== undefined &&
    (typeof conversationId !== "string" || !/^[0-9a-f-]{36}$/.test(conversationId))
  ) {
    return error("Invalid shopping conversation.", 400);
  }
  const action = fields.action as ShoppingAction | undefined;
  if (
    action !== undefined &&
    (!action ||
      typeof action !== "object" ||
      !["confirm", "cancel", "status", "retry"].includes(action.type) ||
      (action.token !== undefined &&
        (typeof action.token !== "string" || action.token.length > 100)))
  ) {
    return error("Invalid shopping action.", 400);
  }
  const confirmation = fields.confirmation;
  if (
    confirmation !== undefined &&
    (typeof confirmation !== "string" || confirmation.length > 100)
  ) {
    return error("Invalid confirmation.", 400);
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return error(
      "Chat is not configured. Set OPENAI_API_KEY on the server and restart the app.",
      503
    );
  }

  const release = acquireChatSlot();
  if (!release) {
    return Response.json(
      { error: "Chat usage limit reached. Please try again later." },
      {
        status: 429,
        headers: { "Cache-Control": "no-store", "Retry-After": "60" },
      }
    );
  }
  let shopping: ReturnType<typeof shoppingStore.acquire> | undefined;
  try {
    shopping = shoppingStore.acquire(shoppingOwner(request), conversationId);
    const client = new OpenAI({ apiKey, timeout: 60_000, maxRetries: 0, logLevel: "off" });
    const message = await runChat(messages, {
      model: process.env.OPENAI_MODEL?.trim() || "gpt-6-luna",
      responses: client.responses,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]),
      discoveryEnabled: discoveryEnabled(),
      agentId,
      shopping: { state: shopping.state, action, confirmation },
    });
    return Response.json(
      { message, conversationId: shopping.id },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("shopping_")) {
      return error(
        "Shopping context expired or is busy. If no request is running, start a new chat. No payment was sent by this request.",
        409
      );
    }
    if (cause instanceof OpenAI.APIConnectionTimeoutError) {
      return error("The assistant took too long to respond. Please try again.", 504);
    }
    if (cause instanceof OpenAI.APIError) {
      if (cause.status === 429) {
        return error(
          "Chat usage is currently limited. Please try again later or check the server's OpenAI quota.",
          429
        );
      }
      if (cause.status === 401 || cause.status === 403 || cause.status === 404) {
        return error(
          "Chat configuration is unavailable. Check the server's OpenAI credentials and model access.",
          503
        );
      }
    }
    return error("Unable to complete the reply. Please try again later.", 502);
  } finally {
    shopping?.release();
    release();
  }
}

// Reset local orchestration only; abandoning a chat does not cancel a merchant checkout.
export async function DELETE(request: Request) {
  if (!authenticateRequest(request)) {
    return error("Please sign in to use chat.", 401);
  }
  if (!trustedMutationOrigin(request)) {
    return error("This request is not allowed.", 403);
  }
  const id = new URL(request.url).searchParams.get("conversationId");
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
    return error("Invalid shopping conversation.", 400);
  }
  try {
    shoppingStore.reset(shoppingOwner(request), id);
  } catch {
    return error("Wait for the current shopping request to finish.", 409);
  }
  return Response.json({ reset: true }, { headers: { "Cache-Control": "no-store" } });
}
