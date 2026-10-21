import ipaddr from "ipaddr.js";

function isPublicCatalogUrl(value: unknown, allowQuery: boolean): value is string {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\s\\\u0000-\u001f\u007f]/u.test(value)
  ) {
    return false;
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (!allowQuery && url.search) ||
      value.includes("#") ||
      (url.port && url.port !== "443") ||
      value
        .slice(value.indexOf("//") + 2)
        .split("/")[0]
        .includes("@")
    ) {
      return false;
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (ipaddr.isValid(host)) {
      const address = ipaddr.parse(host);
      if (address.range() !== "unicast" || host === "168.63.129.16") {
        return false;
      }
      if (address.kind() === "ipv6") {
        const ipv6 = address as ipaddr.IPv6;
        return (
          ipv6.match(ipaddr.parse("2000::") as ipaddr.IPv6, 3) &&
          !ipv6.match(ipaddr.parse("2001::") as ipaddr.IPv6, 23) &&
          !ipv6.match(ipaddr.parse("2001:db8::") as ipaddr.IPv6, 32) &&
          !ipv6.match(ipaddr.parse("3fff::") as ipaddr.IPv6, 20)
        );
      }
      return true;
    }
    return (
      host.length <= 253 &&
      host.includes(".") &&
      !host.endsWith(".") &&
      host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) &&
      !/(?:^|\.)(?:localhost|local|internal|invalid|test)$/i.test(host)
    );
  } catch {
    return false;
  }
}

/** Browser-side media guard. Images load directly; this does not proxy or fetch them on our server. */
export function isCatalogImageUrl(value: unknown): value is string {
  return isPublicCatalogUrl(value, false);
}

/** Preserve merchant offer/variant query parameters on navigation links only. */
export function isCatalogProductUrl(value: unknown): value is string {
  return isPublicCatalogUrl(value, true);
}
