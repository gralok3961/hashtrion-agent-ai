import { isHttpsLink } from "./discovery-types";
import { isCatalogImageUrl, isCatalogProductUrl } from "./catalog-media";

export const MAX_CATALOG_PRODUCTS = 100;
export type CatalogFilters = { categories?: string[]; price?: { min?: number; max?: number } };

export type CatalogPrice = { amount: number; currency: string };
export type CatalogImage = { url: string; alt?: string };
export type CatalogVariant = {
  id: string;
  title: string;
  description?: string;
  url?: string;
  images: CatalogImage[];
  price: CatalogPrice;
  available?: boolean;
  options?: { name: string; value: string }[];
};
export type CatalogProduct = {
  id: string;
  title: string;
  description?: string;
  url?: string;
  images: CatalogImage[];
  variants: CatalogVariant[];
  priceRange?: { min: CatalogPrice; max: CatalogPrice };
};
export type CatalogMessage = { type: "error" | "warning" | "info"; code?: string; content: string };
export type CatalogReport = {
  status:
    | "completed"
    | "unsupported"
    | "platform_unavailable"
    | "request_failed"
    | "invalid_response"
    | "merchant_error";
  merchantDomain: string;
  provider?: "shopify-global";
  query: string;
  filters?: CatalogFilters;
  context?: { currency: string };
  continuation?: string;
  products: CatalogProduct[];
  messages: CatalogMessage[];
  pagination?: { cursor?: string; hasNextPage: boolean; totalCount?: number };
  diagnostics: {
    profileUrl: string;
    endpoint?: string;
    version?: string;
    requestId?: string;
    httpStatus?: number;
    transport?: "rest" | "mcp";
    reason?: string;
  };
};

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
const optionalText = (v: unknown, max: number) => v === undefined || text(v, max);
const optionalUrl = (v: unknown) => v === undefined || isHttpsLink(v);
const optionalProductUrl = (v: unknown) => v === undefined || isCatalogProductUrl(v);
const nonnegative = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const price = (v: unknown) =>
  record(v) &&
  nonnegative(v.amount) &&
  typeof v.currency === "string" &&
  /^[A-Z]{3}$/.test(v.currency);
const priceRange = (v: unknown) => {
  if (!record(v) || !price(v.min) || !price(v.max)) {
    return false;
  }
  const min = v.min as CatalogPrice,
    max = v.max as CatalogPrice;
  return min.currency === max.currency && min.amount <= max.amount;
};
const images = (v: unknown) =>
  Array.isArray(v) &&
  v.length <= 8 &&
  v.every((i) => record(i) && isCatalogImageUrl(i.url) && optionalText(i.alt, 300));
const variant = (v: unknown) =>
  record(v) &&
  text(v.id, 256) &&
  text(v.title, 300) &&
  optionalText(v.description, 2000) &&
  optionalProductUrl(v.url) &&
  images(v.images) &&
  price(v.price) &&
  (v.available === undefined || typeof v.available === "boolean") &&
  (v.options === undefined ||
    (Array.isArray(v.options) &&
      v.options.length <= 16 &&
      v.options.every((o) => record(o) && text(o.name, 100) && text(o.value, 100))));
const product = (v: unknown) =>
  record(v) &&
  text(v.id, 256) &&
  text(v.title, 300) &&
  optionalText(v.description, 2000) &&
  optionalProductUrl(v.url) &&
  images(v.images) &&
  Array.isArray(v.variants) &&
  v.variants.length > 0 &&
  v.variants.length <= 20 &&
  v.variants.every(variant) &&
  (v.priceRange === undefined || priceRange(v.priceRange));

export function isCatalogFilters(value: unknown): value is CatalogFilters {
  if (!record(value) || Object.keys(value).some((key) => key !== "categories" && key !== "price")) {
    return false;
  }
  const categories = value.categories;
  if (
    categories !== undefined &&
    (!Array.isArray(categories) ||
      categories.length === 0 ||
      categories.length > 10 ||
      !categories.every((c) => text(c, 100)))
  ) {
    return false;
  }
  const p = value.price;
  if (
    p !== undefined &&
    (!record(p) ||
      Object.keys(p).some((key) => key !== "min" && key !== "max") ||
      (p.min === undefined && p.max === undefined) ||
      (p.min !== undefined && !nonnegative(p.min)) ||
      (p.max !== undefined && !nonnegative(p.max)) ||
      (typeof p.min === "number" && typeof p.max === "number" && p.min > p.max))
  ) {
    return false;
  }
  return categories !== undefined || p !== undefined;
}

/** Validate data restored from browser session storage before rendering it. */
export function isCatalogReport(value: unknown): value is CatalogReport {
  if (
    !record(value) ||
    ![
      "completed",
      "unsupported",
      "platform_unavailable",
      "request_failed",
      "invalid_response",
      "merchant_error",
    ].includes(String(value.status)) ||
    !text(value.merchantDomain, 253) ||
    typeof value.query !== "string" ||
    value.query.length > 500 ||
    (!value.query.trim() && !isCatalogFilters(value.filters)) ||
    !Array.isArray(value.products) ||
    value.products.length > MAX_CATALOG_PRODUCTS ||
    !value.products.every(product) ||
    !Array.isArray(value.messages) ||
    value.messages.length > 20 ||
    !value.messages.every(
      (m) =>
        record(m) &&
        ["error", "warning", "info"].includes(String(m.type)) &&
        optionalText(m.code, 100) &&
        text(m.content, 1000)
    )
  ) {
    return false;
  }
  if (
    (value.provider !== undefined && value.provider !== "shopify-global") ||
    (value.filters !== undefined && !isCatalogFilters(value.filters)) ||
    !optionalText(value.continuation, 8192)
  ) {
    return false;
  }
  if (
    value.context !== undefined &&
    (!record(value.context) ||
      Object.keys(value.context).some((key) => key !== "currency") ||
      typeof value.context.currency !== "string" ||
      !/^[A-Z]{3}$/.test(value.context.currency))
  ) {
    return false;
  }
  if (value.status !== "completed" && value.products.length > 0) {
    return false;
  }
  const p = value.pagination;
  if (
    p !== undefined &&
    (!record(p) ||
      typeof p.hasNextPage !== "boolean" ||
      !optionalText(p.cursor, 2048) ||
      (p.hasNextPage && !text(p.cursor, 2048)) ||
      (p.totalCount !== undefined && !nonnegative(p.totalCount)))
  ) {
    return false;
  }
  const d = value.diagnostics;
  return (
    record(d) &&
    isHttpsLink(d.profileUrl) &&
    optionalUrl(d.endpoint) &&
    optionalText(d.version, 10) &&
    optionalText(d.requestId, 100) &&
    optionalText(d.reason, 100) &&
    (d.transport === undefined || d.transport === "rest" || d.transport === "mcp") &&
    (d.httpStatus === undefined ||
      (Number.isInteger(d.httpStatus) &&
        Number(d.httpStatus) >= 100 &&
        Number(d.httpStatus) <= 599))
  );
}
