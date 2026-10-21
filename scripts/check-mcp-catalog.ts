// Operator-only, read-only live check. No environment files, OpenAI, or secrets.
import { catalogSearch, catalogEndpoint } from "../src/lib/server/catalog";
import { verifyCandidates } from "../src/lib/server/discovery";
import { searchMcpCatalog } from "../src/lib/server/mcp-catalog";
import { createMcpFetch, safePublicUrl } from "../src/lib/server/safe-http";
import { acquireChatSlot } from "../src/lib/server/usage-guard";

async function main() {
  const [domain, platformProfileUrl, ...words] = process.argv.slice(2);
  const query = words.join(" ").trim();
  if (!domain || !platformProfileUrl || !query || query.length > 500) {
    throw new Error();
  }
  const merchantUrl = safePublicUrl(`https://${domain}`);
  if (merchantUrl.hostname !== domain || merchantUrl.pathname !== "/" || merchantUrl.search) {
    throw new Error();
  }
  const signal = AbortSignal.timeout(60_000);
  const release = acquireChatSlot();
  if (!release) {
    throw new Error();
  }
  try {
    const [merchant] = await verifyCandidates(
      [{ url: merchantUrl.href, title: domain, kind: "user_provided" }],
      signal
    );
    console.log(
      JSON.stringify({
        discovery: merchant?.status,
        reason: merchant?.status === "unverified" ? merchant.reason : undefined,
      })
    );
    if (merchant?.status !== "verified" || catalogEndpoint(merchant)?.transport !== "mcp") {
      throw new Error();
    }
    const report = await catalogSearch(
      merchant,
      query,
      { platformProfileUrl, signal },
      {
        mcp: (endpoint, profile, input, signal) =>
          searchMcpCatalog(endpoint, profile, input, signal, {
            createFetch: (endpoint, profile, signal) => {
              const fetch = createMcpFetch(endpoint, profile, signal);
              return async (input, init) => {
                const response = await fetch(input, init);
                // Allowlisted method and status only; never raw bodies or session IDs.
                if (init?.method === "POST" && typeof init.body === "string") {
                  const method: unknown = JSON.parse(init.body).method;
                  if (
                    [
                      "initialize",
                      "notifications/initialized",
                      "tools/list",
                      "tools/call",
                    ].includes(String(method))
                  ) {
                    console.log(JSON.stringify({ method, httpStatus: response.status }));
                  }
                }
                return response;
              };
            },
          }),
      }
    );
    console.log(
      JSON.stringify(
        {
          status: report.status,
          transport: report.diagnostics.transport,
          reason: report.diagnostics.reason,
          products: report.products.map((p) => ({
            title: p.title,
            price: p.priceRange,
            images: p.images.length,
            variants: p.variants.length,
          })),
          hasNextPage: report.pagination?.hasNextPage,
        },
        null,
        2
      )
    );
    if (report.status !== "completed") {
      process.exitCode = 1;
    }
  } finally {
    release();
  }
}
main().catch(() => {
  console.error(
    "MCP check did not complete. Supply a public merchant domain, this app's public platform profile URL, and search keywords. No successful catalog is claimed."
  );
  process.exitCode = 1;
});
