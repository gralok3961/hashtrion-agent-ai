import { CATALOG_CAPABILITY, CATALOG_VERSION } from "./platform-profile";

export type CatalogProvider = Readonly<{
  id: "shopify-global";
  name: string;
  endpoint: string;
  documentation: string;
  transport: "mcp";
  version: string;
  capability: string;
  enabled: boolean;
}>;

/** Operator-owned infrastructure, separate from discovered merchant profiles. */
export const SHOPIFY_GLOBAL_PROVIDER: CatalogProvider = Object.freeze({
  id: "shopify-global",
  name: "Shopify Global Catalog",
  endpoint: "https://catalog.shopify.com/api/ucp/mcp",
  documentation: "https://shopify.dev/docs/agents/catalog/global-catalog",
  transport: "mcp",
  version: CATALOG_VERSION,
  capability: CATALOG_CAPABILITY,
  enabled: true,
});

// Change enabled here to disable a provider. Search requests and environment
// values cannot add providers, replace endpoints or select an arbitrary URL.
export const CATALOG_PROVIDER_REGISTRY: readonly CatalogProvider[] = Object.freeze([
  SHOPIFY_GLOBAL_PROVIDER,
]);

function compatible(provider: CatalogProvider): boolean {
  return (
    provider.enabled &&
    provider.transport === "mcp" &&
    provider.version === CATALOG_VERSION &&
    provider.capability === CATALOG_CAPABILITY
  );
}

export function getCatalogProvider(
  id: string,
  registry: readonly CatalogProvider[] = CATALOG_PROVIDER_REGISTRY
): CatalogProvider | undefined {
  return registry.find((provider) => provider.id === id && compatible(provider));
}

export function defaultCatalogProvider(
  registry: readonly CatalogProvider[] = CATALOG_PROVIDER_REGISTRY
): CatalogProvider | undefined {
  return registry.find(compatible);
}
