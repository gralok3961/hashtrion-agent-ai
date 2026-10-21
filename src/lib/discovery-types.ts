export type SearchSource = { url: string; title: string; kind?: "web_search" | "user_provided" };
export type UcpDetails = {
  version: string;
  services: { name: string; version: string; transport: string; endpoint?: string }[];
  capabilities: { name: string; version: string }[];
  restEndpoints: { service: string; version: string; url: string }[];
};
export type MerchantResult = {
  domain: string;
  profileUrl: string;
} & (
  | { status: "verified"; profile: UcpDetails }
  | {
      status: "unverified";
      reason:
        | "not_found"
        | "unsafe_destination"
        | "invalid_profile"
        | "no_rest"
        | "no_supported_transport"
        | "fetch_failed";
    }
);
export type DiscoveryReport = {
  status: "completed" | "no_sources" | "search_failed" | "disabled";
  searchIncomplete?: boolean;
  sources: SearchSource[];
  merchants: MerchantResult[];
};

// Used before rendering links from JSON or session storage.
export function isHttpsLink(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443")
    );
  } catch {
    return false;
  }
}

export function isDiscoveryReport(value: unknown): value is DiscoveryReport {
  if (!value || typeof value !== "object") {
    return false;
  }
  const report = value as DiscoveryReport;
  if (
    (report.searchIncomplete !== undefined && typeof report.searchIncomplete !== "boolean") ||
    !["completed", "no_sources", "search_failed", "disabled"].includes(report.status) ||
    !Array.isArray(report.sources) ||
    report.sources.length > 10 ||
    !Array.isArray(report.merchants) ||
    report.merchants.length > 5
  ) {
    return false;
  }
  const text = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 256;
  return (
    report.sources.every(
      (s) =>
        s &&
        isHttpsLink(s.url) &&
        text(s.title) &&
        (s.kind === undefined || s.kind === "web_search" || s.kind === "user_provided")
    ) &&
    report.merchants.every((m) => {
      if (!m || !text(m.domain) || !isHttpsLink(m.profileUrl)) {
        return false;
      }
      // Keep the former no_rest reason readable in previously saved session history.
      if (m.status === "unverified") {
        return [
          "not_found",
          "unsafe_destination",
          "invalid_profile",
          "no_rest",
          "no_supported_transport",
          "fetch_failed",
        ].includes(m.reason);
      }
      if (m.status !== "verified" || !m.profile || !text(m.profile.version)) {
        return false;
      }
      const p = m.profile;
      return (
        Array.isArray(p.services) &&
        p.services.length <= 64 &&
        p.services.every(
          (s) =>
            s &&
            text(s.name) &&
            text(s.version) &&
            text(s.transport) &&
            (!s.endpoint || isHttpsLink(s.endpoint))
        ) &&
        Array.isArray(p.capabilities) &&
        p.capabilities.length <= 64 &&
        p.capabilities.every((c) => c && text(c.name) && text(c.version)) &&
        Array.isArray(p.restEndpoints) &&
        p.restEndpoints.length <= 64 &&
        p.restEndpoints.every(
          (e) => e && text(e.service) && text(e.version) && isHttpsLink(e.url)
        ) &&
        (p.restEndpoints.length > 0 ||
          p.services.some((s) => s.transport === "mcp" && isHttpsLink(s.endpoint)))
      );
    })
  );
}
