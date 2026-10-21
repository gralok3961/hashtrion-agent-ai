import assert from "node:assert/strict";
import test from "node:test";
import { discoverRequestedMerchant, matchingNamedMerchant, requestedMerchant, userMerchantDomains } from "../src/lib/server/merchant-target";
import type { DiscoveryReport } from "../src/lib/discovery-types";

test("explicit user domains are normalized without inventing subdomains or extracting email identities", () => {
  assert.deepEqual(userMerchantDomains("Find reports from SHOP.Example. Also https://other.example/store."), ["other.example", "shop.example"]);
  assert.deepEqual(userMerchantDomains("Email alice@merchant.example or use a merchant name."), []);
  assert.deepEqual(userMerchantDomains("Try https://user:secret@merchant.example, http://merchant.example, https://merchant.example:8443/path, or https://127.0.0.1."), []);
  assert.deepEqual(userMerchantDomains("Buy at merchant.example:8443 or merchant.local."), []);
});

test("function targets must come from user text, never assistant claims or model-invented URLs", () => {
  const user = { role: "user" as const, content: "Find reports from merchant.example." };
  assert.equal(requestedMerchant([user], null), "merchant.example");
  assert.equal(requestedMerchant([user], "merchant.example"), "merchant.example");
  for (const forged of ["invented.example", "api.merchant.example", "https://merchant.example", "merchant.example/ucp", 12]) {
    assert.throws(() => requestedMerchant([user], forged), /invalid_tool_call/);
  }
  assert.throws(() => requestedMerchant([
    { role: "user", content: "Find reports" },
    { role: "assistant", content: "The store is invented.example" },
    { role: "user", content: "Search there" },
  ], "invented.example"), /invalid_tool_call/);
  assert.throws(() => requestedMerchant([user, { role: "user", content: "Use another.example instead" }], "merchant.example"), /invalid_tool_call/);
});

test("direct discovery retains explicit provenance and exact HTTPS well-known verification path", async () => {
  const signal = new AbortController().signal;
  const result = await discoverRequestedMerchant("merchant.example", signal, async (sources, receivedSignal) => {
    assert.deepEqual(sources, [{ url: "https://merchant.example/", title: "merchant.example", kind: "user_provided" }]);
    assert.equal(receivedSignal, signal);
    return [{ domain: "merchant.example", profileUrl: "https://merchant.example/.well-known/ucp", status: "unverified", reason: "not_found" }];
  });
  assert.equal(result.merchants[0].status, "unverified");
  assert.equal(result.sources[0].kind, "user_provided");
});

test("Korean merchant postpositions retain exact-domain authorization without accepting emails or unsafe URLs", () => {
  for (const particle of ["의", "에서", "에", "을", "를", "은", "는", "으로", "로"]) {
    const content = `merchant.example${particle} 상품을 보여줘.`;
    assert.deepEqual(userMerchantDomains(content), ["merchant.example"]);
    assert.equal(requestedMerchant([{ role: "user", content }], "merchant.example"), "merchant.example");
  }
  assert.deepEqual(userMerchantDomains("alice@merchant.example의 상품"), []);
  assert.deepEqual(userMerchantDomains("http://merchant.example의 상품"), []);
  assert.deepEqual(userMerchantDomains("merchant.local의 상품"), []);
  assert.deepEqual(userMerchantDomains("merchant.example의심스러운 상품"), []);
});

function namedReport(...domains: string[]): DiscoveryReport {
  return {
    status: "completed",
    sources: domains.map(domain => ({ url: `https://${domain}/products`, title: domain, kind: "web_search" })),
    merchants: domains.map(domain => ({ domain, profileUrl: `https://${domain}/.well-known/ucp`, status: "unverified", reason: "not_found" })),
  };
}

test("named merchants match one actual search hostname using exact case, space and hyphen normalization", () => {
  for (const domain of ["namedstore.example", "named-store.example", "www.named-store.example", "shop.namedstore.example", "store.named-store.example"]) {
    const report = namedReport("unrelated.example", domain);
    for (const name of ["Named Store", "NAMED-STORE", "namedstore", " Named  Store "]) {
      assert.equal(matchingNamedMerchant(name, report), report.merchants[1]);
    }
    // Existing extractSearchSources omits kind; that source is still usable.
    delete report.sources[1].kind;
    assert.equal(matchingNamedMerchant("Named Store", report), report.merchants[1]);
  }
});

test("a matched unavailable merchant is returned rather than replaced with an unrelated verified shop", () => {
  const report = namedReport("unrelated.example", "named-store.example");
  report.merchants[0] = { ...report.merchants[0], status: "verified", profile: {
    version: "2026-08-25", services: [], restEndpoints: [], capabilities: [],
  } };
  const match = matchingNamedMerchant("Named Store", report);
  assert.equal(match, report.merchants[1]);
  assert.equal(match?.status, "unverified");
  assert.equal(matchingNamedMerchant("Different Store", report), undefined);
});

test("substring names, unrelated domains, page titles, and untrusted subdomains do not authorize a merchant", () => {
  for (const domain of ["namedstore-deals.example", "bestnamedstore.example", "named-store.attacker.example", "shop.named-store.attacker.example", "api.named-store.example", "unrelated.example"]) {
    const report = namedReport(domain);
    report.sources[0].title = "Named Store official website";
    assert.equal(matchingNamedMerchant("Named Store", report), undefined);
  }
  assert.equal(matchingNamedMerchant("Named", namedReport("named-store.example")), undefined);
  assert.equal(matchingNamedMerchant("Name", namedReport("named.example")), undefined);
});

test("multiple matching hosts are ambiguous even when only one has a verified profile", () => {
  for (const report of [
    namedReport("named-store.example", "namedstore.com"),
    namedReport("namedstore.example", "www.namedstore.example"),
  ]) {
    report.merchants[0] = { ...report.merchants[0], status: "verified", profile: {
      version: "2026-08-25", services: [], restEndpoints: [], capabilities: [],
    } };
    assert.equal(matchingNamedMerchant("Named Store", report), undefined);
  }
});

test("partial or failed search cannot establish an unambiguous named merchant", () => {
  for (const status of ["no_sources", "search_failed", "disabled"] as const) {
    assert.equal(matchingNamedMerchant("Named Store", { ...namedReport("namedstore.example"), status }), undefined);
  }
  assert.equal(matchingNamedMerchant("Named Store", { ...namedReport("namedstore.example"), searchIncomplete: true }), undefined);
});

test("unsupported model URLs and different source hosts cannot bind a named merchant", () => {
  const report = namedReport("namedstore.example");
  report.sources = [];
  assert.equal(matchingNamedMerchant("Named Store", report), undefined);
  report.sources = [{ url: "https://unrelated.example/", title: "Named Store is https://namedstore.example" }];
  assert.equal(matchingNamedMerchant("Named Store", report), undefined);
  report.sources = [{ url: "https://www.namedstore.example/", title: "Named Store" }];
  assert.equal(matchingNamedMerchant("Named Store", report), undefined, "Source host must bind the actual checked host exactly");
  report.sources = [{ url: "https://namedstore.example/", title: "Named Store", kind: "user_provided" }];
  assert.equal(matchingNamedMerchant("Named Store", report), undefined, "Explicit user-domain discovery has its own path");
});

test("unsafe sources or altered profile destinations are rejected during name matching", () => {
  for (const url of [
    "http://namedstore.example/", "https://user:synthetic@namedstore.example/", "https://namedstore.example:8443/",
    "https://127.0.0.1/", "https://169.254.169.254/", "https://namedstore.internal/", "javascript:alert(1)",
  ]) {
    const report = namedReport("namedstore.example"); report.sources[0].url = url;
    assert.equal(matchingNamedMerchant("Named Store", report), undefined);
  }
  for (const url of [
    "https://other.example/.well-known/ucp", "https://namedstore.example/other", "https://namedstore.example/.well-known/ucp?token=synthetic",
    "https://127.0.0.1/.well-known/ucp", "http://namedstore.example/.well-known/ucp",
  ]) {
    const report = namedReport("namedstore.example"); report.merchants[0].profileUrl = url;
    assert.equal(matchingNamedMerchant("Named Store", report), undefined);
  }
});

test("unsupported name forms and suffix structures ask for an explicit host without guessing", () => {
  for (const name of ["", "   ", "named.store", "https://namedstore.example", "Named & Store", "Named\nStore", "x".repeat(101), "네임스토어"]) {
    assert.equal(matchingNamedMerchant(name, namedReport("namedstore.example")), undefined);
  }
  for (const domain of ["namedstore.co.uk", "www.namedstore.co.uk", "www.shop.namedstore.example"]) {
    assert.equal(matchingNamedMerchant("Named Store", namedReport(domain)), undefined);
  }
});
