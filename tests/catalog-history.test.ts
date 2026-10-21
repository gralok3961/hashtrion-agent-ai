import assert from "node:assert/strict";
import test from "node:test";
import { isChatHistory } from "../src/lib/chat";
import type { CatalogReport } from "../src/lib/catalog-types";

function report(): CatalogReport {
  return {
    status: "completed",
    merchantDomain: "merchant.example",
    query: "annual reports",
    products: [{
      id: "report",
      title: "Annual Report",
      description: "The merchant's real description.",
      url: "https://merchant.example/reports/annual",
      images: [{ url: "https://merchant.example/media/report.png", alt: "Report cover" }],
      variants: [{ id: "report-pdf", title: "PDF", images: [], price: { amount: 400, currency: "USD" } }],
    }],
    messages: [],
    pagination: { hasNextPage: false, totalCount: 1 },
    diagnostics: {
      profileUrl: "https://merchant.example/.well-known/ucp",
      endpoint: "https://api.merchant.example/ucp",
      version: "2026-08-25",
    },
  };
}

test("session history preserves validated catalog metadata and integer prices", () => {
  const history: unknown = JSON.parse(JSON.stringify([
    { role: "user", content: "Find annual reports." },
    { role: "assistant", content: "One report was found.", catalog: report() },
  ]));
  assert.ok(isChatHistory(history));
  assert.equal(history[1].catalog?.products[0].variants[0].price.amount, 400);
  assert.equal(history[1].catalog?.pagination?.totalCount, 1);
});

test("session history rejects unsafe product or image links and corrupt prices", () => {
  for (const corrupt of [
    (value: CatalogReport) => { value.products[0].url = "javascript:alert(1)"; },
    (value: CatalogReport) => { value.products[0].url = "https://127.0.0.1/product?variant=123"; },
    (value: CatalogReport) => { value.products[0].variants[0].url = "https://user:synthetic@merchant.example/product?variant=123"; },
    (value: CatalogReport) => { value.products[0].images[0].url = "http://merchant.example/image.png"; },
    (value: CatalogReport) => { value.products[0].variants[0].price.amount = 4.5; },
    (value: CatalogReport) => { value.products[0].variants[0].price.amount = Number.MAX_SAFE_INTEGER + 1; },
  ]) {
    const catalog = report();
    corrupt(catalog);
    assert.equal(isChatHistory([
      { role: "user", content: "Find annual reports." },
      { role: "assistant", content: "A report was found.", catalog },
    ]), false);
  }
});

test("catalog evidence cannot be attached to a user turn in restored history", () => {
  assert.equal(isChatHistory([{ role: "user", content: "Find reports.", catalog: report() }]), false);
});

test("session history retains exact product and variant navigation query parameters", () => {
  const catalog = report();
  catalog.provider = "shopify-global";
  catalog.products[0].url = "https://seller.example/products/report?country=US&currency=USD";
  catalog.products[0].variants[0].url = "https://seller.example/products/report?variant=123&country=US";
  const history: unknown = JSON.parse(JSON.stringify([
    { role: "user", content: "Find reports." },
    { role: "assistant", content: "One report was found.", catalog },
  ]));
  assert.ok(isChatHistory(history));
  assert.equal(history[1].catalog?.products[0].url, catalog.products[0].url);
  assert.equal(history[1].catalog?.products[0].variants[0].url, catalog.products[0].variants[0].url);
});
