// Explicit, bounded live check. Loads no environment file itself and prints no keys.
import OpenAI from "openai";
import { runChat } from "../src/lib/server/chat-service";
import { acquireChatSlot, discoveryEnabled } from "../src/lib/server/usage-guard";

async function main() {
  const query = process.argv.slice(2).join(" ").trim();
  if (!query || query.length > 500) {
    throw new Error("Supply a non-sensitive discovery query of 1–500 characters.");
  }
  if (!discoveryEnabled()) {
    throw new Error("Live discovery requires MERCHANT_DISCOVERY_ENABLED=true.");
  }
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("OPENAI_API_KEY is required.");
  }
  const release = acquireChatSlot();
  if (!release) {
    throw new Error("Local usage limit reached.");
  }
  const client = new OpenAI({ timeout: 60_000, maxRetries: 0, logLevel: "off" });
  let calls = 0;
  try {
    const reply = await runChat([{ role: "user", content: query }], {
      model: process.env.OPENAI_MODEL?.trim() || "gpt-6-luna",
      discoveryEnabled: true,
      signal: AbortSignal.timeout(90_000),
      responses: {
        create: async (params, options) => {
          calls++;
          try {
            const result = await client.responses.create(params, options);
            console.log(
              JSON.stringify({
                call: calls,
                status: result.status,
                incomplete: result.incomplete_details?.reason,
                webSearchCalls: result.output
                  .filter((item) => item.type === "web_search_call")
                  .map((item) => ({
                    status: item.status,
                    sources: item.action.type === "search" ? (item.action.sources?.length ?? 0) : 0,
                  })),
              })
            );
            return result;
          } catch (cause) {
            if (cause instanceof OpenAI.APIError) {
              console.error(
                JSON.stringify({
                  call: calls,
                  httpStatus: cause.status,
                  parameter: [
                    "max_tool_calls",
                    "tools",
                    "model",
                    "tool_choice",
                    "include",
                  ].includes(cause.param ?? "")
                    ? cause.param
                    : "not disclosed",
                })
              );
            }
            throw cause;
          }
        },
      },
    });
    console.log(
      JSON.stringify(
        {
          modelCalls: calls,
          reply: reply.content,
          discovery: reply.discovery ?? null,
          catalog: reply.catalog ?? null,
        },
        null,
        2
      )
    );
  } finally {
    release();
  }
}
main().catch((cause: unknown) => {
  // Provider errors can contain request data; do not print them.
  console.error(
    "Live discovery did not complete. Check the documented local environment, OpenAI model access, quota, and network connectivity. No successful discovery is claimed."
  );
  if (cause instanceof OpenAI.APIError) {
    console.error("OpenAI HTTP status:", cause.status ?? "unavailable");
  }
  process.exitCode = 1;
});
