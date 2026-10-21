import {
  isCatalogReport,
  MAX_CATALOG_PRODUCTS,
  type CatalogProduct,
  type CatalogReport,
} from "./catalog-types";
import { isCatalogProductUrl } from "./catalog-media";

export { MAX_CATALOG_PRODUCTS } from "./catalog-types";

/** Merge only pages of the same search. Keep the merchant's latest pagination unchanged. */
export function mergeCatalogPage(current: CatalogReport, next: CatalogReport): CatalogReport {
  if (
    !isCatalogReport(current) ||
    !isCatalogReport(next) ||
    current.status !== "completed" ||
    next.status !== "completed" ||
    current.merchantDomain !== next.merchantDomain ||
    current.provider !== next.provider ||
    current.query !== next.query ||
    JSON.stringify(current.filters ?? null) !== JSON.stringify(next.filters ?? null) ||
    JSON.stringify(current.context ?? null) !== JSON.stringify(next.context ?? null)
  ) {
    throw new Error("Invalid catalog page.");
  }
  const products = new Map(current.products.map((product) => [product.id, product]));
  for (const product of next.products) {
    products.set(product.id, product);
  }
  return { ...next, products: [...products.values()].slice(0, MAX_CATALOG_PRODUCTS) };
}

/** Navigation comes only from the product/variant data, never an invented path. */
export function catalogProductLink(product: CatalogProduct): string | undefined {
  if (isCatalogProductUrl(product.url)) {
    return product.url;
  }
  return product.variants.find((variant) => isCatalogProductUrl(variant.url))?.url;
}

/** A provider spans merchants; its endpoint hostname is not the product's seller. */
export function catalogSellerDomain(
  product: CatalogProduct,
  report: Pick<CatalogReport, "provider" | "merchantDomain">
): string | undefined {
  if (!report.provider) {
    return report.merchantDomain;
  }
  const url = catalogProductLink(product);
  return url ? new URL(url).hostname : undefined;
}

/** Format integer minor units without floating-point division or rounding. */
export function formatMinorPrice(amount: number, currency: string): string {
  if (!Number.isSafeInteger(amount) || amount < 0 || !/^[A-Z]{3}$/.test(currency)) {
    return "Price unavailable";
  }

  // An unknown currency has no trustworthy scale. Preserve its reported units.
  if (!Intl.supportedValuesOf("currency").includes(currency)) {
    return `${amount.toString()} ${currency} minor units`;
  }
  const formatter = new Intl.NumberFormat("en-US", { style: "currency", currency });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 0;
  const scale = BigInt(10) ** BigInt(digits);
  const minor = BigInt(amount);
  const fraction = (minor % scale).toString().padStart(digits, "0");
  const parts = formatter.formatToParts(minor / scale);
  const price = parts.map((part) => (part.type === "fraction" ? fraction : part.value)).join("");
  // Make currencies with shared symbols (for example USD/CAD) unambiguous.
  return parts.some((part) => part.type === "currency" && part.value === currency)
    ? price
    : `${currency} ${price}`;
}
