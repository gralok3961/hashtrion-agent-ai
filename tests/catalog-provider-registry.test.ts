import assert from "node:assert/strict";
import test from "node:test";
import { CATALOG_PROVIDER_REGISTRY, defaultCatalogProvider, getCatalogProvider, SHOPIFY_GLOBAL_PROVIDER } from "../src/lib/server/catalog-provider-registry";

test("default provider is a registered, immutable server entry", () => {
  assert.equal(defaultCatalogProvider(), SHOPIFY_GLOBAL_PROVIDER);
  assert.equal(getCatalogProvider("shopify-global"), SHOPIFY_GLOBAL_PROVIDER);
  assert.equal(SHOPIFY_GLOBAL_PROVIDER.enabled, true);
  assert.equal(Object.isFrozen(CATALOG_PROVIDER_REGISTRY), true);
  assert.equal(Object.isFrozen(SHOPIFY_GLOBAL_PROVIDER), true);
});

test("request-controlled names, domains and endpoints cannot select a provider", () => {
  for (const id of ["", "unknown", "SHOPIFY-GLOBAL", " shopify-global", "catalog.shopify.com", "https://catalog.shopify.com/api/ucp/mcp"]) {
    assert.equal(getCatalogProvider(id), undefined);
  }
});

test("operator disabling or incompatible version/capability removes the provider from both lookups", () => {
  for (const provider of [
    { ...SHOPIFY_GLOBAL_PROVIDER, enabled: false },
    { ...SHOPIFY_GLOBAL_PROVIDER, version: "2099-01-01" },
    { ...SHOPIFY_GLOBAL_PROVIDER, capability: "dev.ucp.shopping.checkout" },
  ]) {
    const registry = Object.freeze([Object.freeze(provider)]);
    assert.equal(defaultCatalogProvider(registry), undefined);
    assert.equal(getCatalogProvider(provider.id, registry), undefined);
  }
  assert.equal(defaultCatalogProvider([]), undefined);
});
