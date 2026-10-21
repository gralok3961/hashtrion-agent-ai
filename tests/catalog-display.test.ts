import assert from "node:assert/strict";
import test from "node:test";
import { catalogProductLink, catalogSellerDomain, formatMinorPrice, mergeCatalogPage, MAX_CATALOG_PRODUCTS } from "../src/lib/catalog-display";
import { isCatalogReport, type CatalogReport } from "../src/lib/catalog-types";
import { isCatalogImageUrl, isCatalogProductUrl } from "../src/lib/catalog-media";

test("prices preserve currency-specific minor units, including free products", () => {
  assert.equal(formatMinorPrice(400, "USD"), "USD $4.00");
  assert.equal(formatMinorPrice(600, "USD"), "USD $6.00");
  assert.equal(formatMinorPrice(0, "USD"), "USD $0.00");
  assert.equal(formatMinorPrice(1, "USD"), "USD $0.01");
  assert.equal(formatMinorPrice(400, "JPY"), "JPY ¥400");
  assert.match(formatMinorPrice(400, "KWD"), /^KWD\s0\.400$/);
});

test("large safe integer prices are not rounded through floating-point division", () => {
  assert.equal(formatMinorPrice(Number.MAX_SAFE_INTEGER, "USD"), "USD $90,071,992,547,409.91");
  assert.match(formatMinorPrice(Number.MAX_SAFE_INTEGER, "KWD"), /9,007,199,254,740\.991$/);
});

test("unknown currency scales and invalid amounts never become invented prices", () => {
  assert.equal(formatMinorPrice(400, "ZZZ"), "400 ZZZ minor units");
  for (const amount of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(formatMinorPrice(amount, "USD"), "Price unavailable");
  }
  assert.equal(formatMinorPrice(400, "usd"), "Price unavailable");
});

function page(ids: string[], cursor?: string): CatalogReport {
  return {
    status: "completed", merchantDomain: "merchant.example", query: "",
    filters: { price: { min: 0 } },
    products: ids.map(id => ({ id, title: id, images: [], variants: [{ id: `${id}-pdf`, title: "PDF", images: [], price: { amount: 400, currency: "USD" } }] })),
    messages: [], pagination: { hasNextPage: !!cursor, ...(cursor ? { cursor } : {}), totalCount: 12 },
    ...(cursor ? { continuation: "opaque-signed-page-reference" } : {}),
    diagnostics: { profileUrl: "https://merchant.example/.well-known/ucp" },
  };
}

test("additional real pages preserve pagination, replace overlapping products, and never duplicate cards", () => {
  const first = page(["a", "b"], "second-page");
  const next = page(["b", "c"]);
  next.products[0].variants[0].price.amount = 500;
  const merged = mergeCatalogPage(first, next);
  assert.deepEqual(merged.products.map(p => p.id), ["a", "b", "c"]);
  assert.equal(merged.products[1].variants[0].price.amount, 500);
  assert.deepEqual(merged.pagination, next.pagination);
  assert.equal(merged.continuation, undefined);
  assert.equal(first.products[1].variants[0].price.amount, 400);
  assert.ok(isCatalogReport(merged));
  assert.deepEqual(mergeCatalogPage(first, page([])).products, first.products);
});

test("page merging rejects a failed page or a changed merchant/search/filter context", () => {
  const first = page(["a"], "next");
  for (const changed of [
    { ...page(["b"]), merchantDomain: "another.example" },
    { ...page(["b"]), query: "different query" },
    { ...page(["b"]), filters: { price: { min: 100 } } },
    { ...page(["b"]), context: { currency: "USD" } },
    { ...page(["b"]), provider: "shopify-global" as const },
    { ...page([]), status: "request_failed" as const },
  ]) assert.throws(() => mergeCatalogPage(first, changed));
});

test("display history is bounded without altering the merchant's next cursor or reported count", () => {
  const first = page(Array.from({ length: 95 }, (_, i) => String(i)), "next");
  const next = page(Array.from({ length: 10 }, (_, i) => String(i + 95)), "third");
  next.pagination!.totalCount = 240;
  const merged = mergeCatalogPage(first, next);
  assert.equal(merged.products.length, MAX_CATALOG_PRODUCTS);
  assert.deepEqual(merged.pagination, { hasNextPage: true, cursor: "third", totalCount: 240 });
  assert.equal(merged.continuation, next.continuation);
});

test("filter-only browse history accepts real filters but rejects fabricated empty or invalid searches", () => {
  assert.ok(isCatalogReport(page([])));
  for (const filters of [{}, { price: {} }, { categories: [] }, { price: { min: -1 } }, { price: { min: 5, max: 4 } }]) {
    assert.equal(isCatalogReport({ ...page([]), filters }), false);
  }
  assert.equal(isCatalogReport({ ...page([]), filters: undefined }), false);
});

test("direct images accept public HTTPS blob/CDN URLs but reject unsafe or credential-bearing URLs", () => {
  for (const url of ["https://store.blob.core.windows.net/catalog/cover.png", "https://media.merchant.example/image.webp"]) assert.equal(isCatalogImageUrl(url), true);
  for (const url of [
    "http://media.merchant.example/image.png", "https://127.0.0.1/image.png", "https://[::1]/image.png",
    "https://10.0.0.1/image.png", "https://169.254.169.254/metadata", "https://168.63.129.16/image.png",
    "https://image.internal/a.png", "https://localhost/a.png", "https://user:password@media.merchant.example/image.png",
    "https://store.blob.core.windows.net/catalog/cover.png?sig=synthetic", "data:image/png;base64,abc", "javascript:alert(1)",
  ]) assert.equal(isCatalogImageUrl(url), false, url);
});

test("product navigation preserves public HTTPS queries without relaxing the image or host guards", () => {
  const url = "https://seller.example/products/report?variant=123&country=US";
  assert.equal(isCatalogProductUrl(url), true);
  assert.equal(isCatalogImageUrl(url), false);
  for (const unsafe of [
    "http://seller.example/product?variant=123", "javascript:alert(1)",
    "https://127.0.0.1/product?variant=123", "https://[::1]/product?variant=123",
    "https://10.0.0.1/product?variant=123", "https://169.254.169.254/product?variant=123",
    "https://168.63.129.16/product?variant=123", "https://seller.internal/product?variant=123",
    "https://user:synthetic@seller.example/product?variant=123", "https://@seller.example/product?variant=123",
    "https://seller.example:444/product?variant=123", "https://seller.example/product?variant=123#fragment",
  ]) assert.equal(isCatalogProductUrl(unsafe), false, unsafe);
});

test("global cards identify sellers from returned product links and fall back only to actual variant links", () => {
  const product = page(["report"]).products[0];
  const provider = { merchantDomain: "catalog.provider.example", provider: "shopify-global" as const };
  product.url = "https://seller.example/products/report?country=US";
  product.variants[0].url = "https://seller.example/products/report?variant=123&country=US";
  assert.equal(catalogProductLink(product), product.url);
  assert.equal(catalogSellerDomain(product, provider), "seller.example");
  assert.equal(catalogSellerDomain(product, { merchantDomain: "verified-merchant.example" }), "verified-merchant.example", "Direct merchant labels preserve verified discovery identity");
  delete product.url;
  assert.equal(catalogProductLink(product), product.variants[0].url);
  assert.equal(catalogSellerDomain(product, provider), "seller.example");
  product.variants[0].url = "https://127.0.0.1/admin?variant=123";
  assert.equal(catalogProductLink(product), undefined);
  assert.equal(catalogSellerDomain(product, provider), undefined, "A provider endpoint must never become an invented seller");
});

test("saved catalog provider identity is explicit and unknown provider claims are rejected", () => {
  assert.equal(isCatalogReport({ ...page(["report"]), provider: "shopify-global" }), true);
  assert.equal(isCatalogReport({ ...page(["report"]), provider: "untrusted-provider" }), false);
});
