import type { ChatMessage } from "../chat";
import type { DiscoveryReport, MerchantResult, SearchSource } from "../discovery-types";
import { verifyCandidates } from "./discovery";
import { safePublicUrl } from "./safe-http";

/** Explicit user input is a separate source; model prose never creates a target. */
export function userMerchantDomains(content: string): string[] {
  const domains = new Set<string>();
  const add = (raw: string) => {
    try {
      domains.add(safePublicUrl(raw).hostname);
    } catch {
      /* No unsafe target. */
    }
  };
  // Consume entire URLs first so an unsafe URL's embedded hostname cannot be
  // reinterpreted as a safe bare domain (credentials, HTTP, or nonstandard ports).
  const withoutUrls = content.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi, (raw) => {
    add(raw.replace(/[.,;)\]}]+$/, ""));
    return " ";
  });
  // Only recognize a complete particle at a word boundary; email/URL exclusions remain.
  for (const match of withoutUrls.matchAll(
    /(?<![\w@/.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?=$|[\s/,;!?()\[\]{}"'`]|\.(?:\s|$)|(?:의|에서|에|을|를|은|는|으로|로)(?:\s|$|[.,!?]))/gi
  )) {
    add(`https://${match[0]}`);
    if (domains.size >= 5) {
      break;
    }
  }
  return [...domains].slice(0, 5);
}

export function requestedMerchant(messages: ChatMessage[], proposed: unknown): string | undefined {
  if (proposed !== null && proposed !== undefined && typeof proposed !== "string") {
    throw new Error("invalid_tool_call");
  }
  const current = userMerchantDomains(messages.at(-1)?.content ?? "");
  if (typeof proposed === "string") {
    // A model may select an exact host the user supplied, never derive an API
    // subdomain, URL path, website from assistant history, or a fallback domain.
    const users = messages
      .filter((m) => m.role === "user")
      .flatMap((m) => userMerchantDomains(m.content));
    if (!users.includes(proposed) || (current.length && !current.includes(proposed))) {
      throw new Error("invalid_tool_call");
    }
    return proposed;
  }
  if (current.length === 1) {
    return current[0];
  }
  if (current.length > 1) {
    throw new Error("invalid_tool_call");
  }
  return undefined;
}

/**
 * A conservative source-backed name match, not proof of business ownership.
 * Without a public-suffix database, only two-label storefront hosts and their
 * common storefront subdomains are matched. Other names need an explicit host.
 * Never construct a domain, interpret page titles as identity, or choose an
 * unrelated verified merchant when the named merchant's profile is unavailable.
 */
export function matchingNamedMerchant(
  name: string,
  report: DiscoveryReport
): MerchantResult | undefined {
  if (
    report.status !== "completed" ||
    report.searchIncomplete ||
    report.sources.length > 10 ||
    report.merchants.length > 5 ||
    !name.length ||
    name.length > 100 ||
    !/^[a-z0-9 -]+$/i.test(name)
  ) {
    return;
  }
  const normalized = name.toLowerCase().replace(/[ -]/g, "");
  if (!normalized) {
    return;
  }
  const sourceHosts = new Set<string>();
  for (const source of report.sources) {
    // Existing search extraction leaves kind absent; explicit user sources use
    // a separate direct-domain path and cannot masquerade as web search here.
    if (source.kind !== undefined && source.kind !== "web_search") {
      continue;
    }
    try {
      sourceHosts.add(safePublicUrl(source.url).hostname);
    } catch {
      /* Discard unsafe sources. */
    }
  }
  const matches = report.merchants.filter((merchant) => {
    if (!sourceHosts.has(merchant.domain)) {
      return false;
    }
    try {
      const profile = safePublicUrl(merchant.profileUrl);
      if (
        profile.hostname !== merchant.domain ||
        profile.pathname !== "/.well-known/ucp" ||
        profile.search
      ) {
        return false;
      }
      const labels = profile.hostname.split(".");
      if (labels.length === 3 && ["www", "shop", "store"].includes(labels[0])) {
        labels.shift();
      }
      return labels.length === 2 && labels[0].replace(/-/g, "") === normalized;
    } catch {
      return false;
    }
  });
  // Even an unavailable profile counts toward ambiguity; do not substitute a
  // differently hosted merchant just because its profile happens to work.
  return matches.length === 1 ? matches[0] : undefined;
}

export async function discoverRequestedMerchant(
  domain: string,
  signal: AbortSignal,
  verify: typeof verifyCandidates = verifyCandidates
): Promise<DiscoveryReport> {
  const url = safePublicUrl(`https://${domain}`);
  if (url.hostname !== domain || url.pathname !== "/" || url.search) {
    throw new Error("invalid_tool_call");
  }
  const sources: SearchSource[] = [{ url: url.href, title: domain, kind: "user_provided" }];
  return { status: "completed", sources, merchants: await verify(sources, signal) };
}
