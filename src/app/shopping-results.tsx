"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { CatalogImage, CatalogProduct, CatalogReport } from "@/lib/catalog-types";
import {
  catalogProductLink,
  catalogSellerDomain,
  formatMinorPrice,
  MAX_CATALOG_PRODUCTS,
} from "@/lib/catalog-display";
import { isCatalogImageUrl, isCatalogProductUrl } from "@/lib/catalog-media";
import type { DiscoveryReport } from "@/lib/discovery-types";
import styles from "./shopping.module.css";

const copy = {
  products: "Products",
  details: "View details",
  close: "Close product details",
  imageMissing: "Image unavailable",
  description: "About this product",
  variants: "Options",
  available: "Available",
  unavailable: "Unavailable",
  priceMissing: "Price unavailable",
  more: "Show more products",
  loading: "Loading products…",
  sources: "Sources",
  empty: "No products found. Try another keyword or filter.",
  limit: "Showing the first 100 products. Refine your search to explore more.",
  failed: "Products are unavailable right now. Please try again.",
  unsupported: "This merchant does not support this product search.",
  note: "The merchant returned a notice with these results. Some information may be unavailable.",
  incomplete: "Search results may be incomplete.",
  visit: "View on merchant site",
  from: "from",
  sellerMissing: "Seller unavailable",
};

function ProductImage({
  image,
  title,
  large = false,
}: {
  image?: CatalogImage;
  title: string;
  large?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={`${styles.imageFrame} ${large ? styles.largeImage : ""}`}>
      {image && isCatalogImageUrl(image.url) && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- Real merchant HTTPS media; intentionally no image optimization proxy.
        <img
          src={image.url}
          alt={image.alt || title}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className={styles.imageFallback} role="img" aria-label={copy.imageMissing}>
          <svg width="34" height="34" viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <rect
              x="4"
              y="4"
              width="24"
              height="24"
              rx="5"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="m5 24 7-7 5 5 5-9 5 7"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
          <span>{copy.imageMissing}</span>
        </span>
      )}
    </span>
  );
}

function productPrice(product: CatalogProduct) {
  if (product.priceRange) {
    const { min, max } = product.priceRange;
    const first = formatMinorPrice(min.amount, min.currency);
    return min.amount === max.amount && min.currency === max.currency
      ? first
      : `${first} – ${formatMinorPrice(max.amount, max.currency)}`;
  }
  const prices = product.variants.map((variant) => variant.price);
  if (!prices.length) {
    return copy.priceMissing;
  }
  if (prices.every((price) => price.currency === prices[0].currency)) {
    const min = Math.min(...prices.map((price) => price.amount));
    const max = Math.max(...prices.map((price) => price.amount));
    const first = formatMinorPrice(min, prices[0].currency);
    return min === max ? first : `${first} – ${formatMinorPrice(max, prices[0].currency)}`;
  }
  return copy.variants;
}

function hasDistinctVariantDetails(product: CatalogProduct) {
  if (product.variants.length !== 1) {
    return product.variants.length > 1;
  }
  const variant = product.variants[0];
  if (
    variant.options?.length ||
    variant.available !== undefined ||
    variant.title.trim() !== product.title.trim()
  ) {
    return true;
  }
  if (variant.description && variant.description.trim() !== product.description?.trim()) {
    return true;
  }
  if (variant.url && product.url && variant.url !== product.url) {
    return true;
  }
  if (
    product.priceRange &&
    [product.priceRange.min, product.priceRange.max].some(
      (price) => price.amount !== variant.price.amount || price.currency !== variant.price.currency
    )
  ) {
    return true;
  }
  // Variant images are already used in the gallery when product media is absent.
  return (
    product.images.length > 0 &&
    variant.images.some(
      (image) =>
        !product.images.some(
          (productImage) => productImage.url === image.url && productImage.alt === image.alt
        )
    )
  );
}

export function ProductCard({
  product,
  merchant,
  onSelect,
}: {
  product: CatalogProduct;
  merchant?: string;
  onSelect: () => void;
}) {
  const image = product.images[0] ?? product.variants.flatMap((variant) => variant.images)[0];
  return (
    <article className={styles.productCard}>
      <button
        type="button"
        className={styles.cardButton}
        onClick={onSelect}
        aria-label={`${copy.details}: ${product.title}`}
      >
        <ProductImage key={image?.url ?? "missing"} image={image} title={product.title} />
        <span className={styles.cardBody}>
          <span className={styles.merchant}>{merchant ?? copy.sellerMissing}</span>
          <span className={styles.productTitle}>{product.title}</span>
          {product.description && <span className={styles.description}>{product.description}</span>}
          <span className={styles.price}>{productPrice(product)}</span>
          <span className={styles.cardFoot}>
            <span>
              {product.variants.length > 1 ? `${product.variants.length} options` : copy.details}
            </span>
            <span aria-hidden="true">↗</span>
          </span>
        </span>
      </button>
    </article>
  );
}

function ProductDetails({
  product,
  merchant,
  onClose,
}: {
  product: CatalogProduct;
  merchant?: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const productUrl = catalogProductLink(product);
  useEffect(() => {
    const previousFocus = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      if (previousFocus instanceof HTMLElement) {
        previousFocus.focus();
      }
    };
  }, []);
  const images = product.images.length
    ? product.images
    : product.variants.flatMap((variant) => variant.images).slice(0, 8);
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={heading}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        ) {
          onClose();
        }
      }}
    >
      <button
        autoFocus
        type="button"
        className={styles.close}
        aria-label={copy.close}
        onClick={onClose}
      >
        ×
      </button>
      <div className={styles.detailGallery}>
        {images.length ? (
          images.map((image, index) => (
            <ProductImage key={`${image.url}-${index}`} image={image} title={product.title} large />
          ))
        ) : (
          <ProductImage title={product.title} large />
        )}
      </div>
      <div className={styles.detailBody}>
        <p className={styles.merchant}>{merchant ?? copy.sellerMissing}</p>
        <h2 id={heading}>{product.title}</h2>
        <p className={styles.detailPrice}>{productPrice(product)}</p>
        {product.description && (
          <section>
            <h3>{copy.description}</h3>
            <p className={styles.detailDescription}>{product.description}</p>
          </section>
        )}
        {hasDistinctVariantDetails(product) && (
          <section>
            <h3>{copy.variants}</h3>
            <ul className={styles.variants}>
              {product.variants.map((variant) => (
                <li key={variant.id}>
                  <div className={styles.variantHeading}>
                    <strong>{variant.title}</strong>
                    <span className={styles.variantPrice}>
                      {formatMinorPrice(variant.price.amount, variant.price.currency)}
                    </span>
                  </div>
                  {variant.available !== undefined && (
                    <span className={variant.available ? styles.available : styles.unavailable}>
                      {variant.available ? copy.available : copy.unavailable}
                    </span>
                  )}
                  {variant.options && variant.options.length > 0 && (
                    <p className={styles.variantOptions}>
                      {variant.options
                        .map((option) => `${option.name}: ${option.value}`)
                        .join(" · ")}
                    </p>
                  )}
                  {variant.description && (
                    <p className={styles.detailDescription}>{variant.description}</p>
                  )}
                  {variant.images.length > 0 && (
                    <div className={styles.variantImages}>
                      {variant.images.map((image, index) => (
                        <ProductImage
                          key={`${image.url}-${index}`}
                          image={image}
                          title={variant.title}
                        />
                      ))}
                    </div>
                  )}
                  {isCatalogProductUrl(variant.url) && variant.url !== productUrl && (
                    <a
                      className={styles.merchantLink}
                      href={variant.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      referrerPolicy="no-referrer"
                    >
                      {copy.visit} <span aria-hidden="true">↗</span>
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        {productUrl && (
          <a
            className={styles.merchantLink}
            href={productUrl}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
          >
            {copy.visit} <span aria-hidden="true">↗</span>
          </a>
        )}
      </div>
    </dialog>
  );
}

export function CatalogResults({
  report,
  onLoadMore,
  loading,
  disabled,
  error,
}: {
  report: CatalogReport;
  onLoadMore: () => void;
  loading: boolean;
  disabled: boolean;
  error?: string;
}) {
  const [selected, setSelected] = useState<CatalogProduct | null>(null);
  const total = report.pagination?.totalCount;
  const more = report.pagination?.hasNextPage && report.pagination.cursor && report.continuation;
  const count = `${report.products.length} ${report.products.length === 1 ? "product" : "products"}${total !== undefined ? ` · ${total} total` : ""}`;
  return (
    <section className={styles.catalog} aria-label={copy.products} aria-busy={loading}>
      <div className={styles.catalogHeading}>
        <h3>{copy.products}</h3>
        <span>{count}</span>
      </div>
      {report.products.length > 0 && (
        <div className={styles.productGrid}>
          {report.products.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              merchant={catalogSellerDomain(product, report)}
              onSelect={() => setSelected(product)}
            />
          ))}
        </div>
      )}
      {report.status === "completed" && report.products.length === 0 && (
        <p className={styles.empty}>{copy.empty}</p>
      )}
      {report.status !== "completed" && (
        <p className={styles.resultNotice} role="status">
          {report.status === "unsupported" ? copy.unsupported : copy.failed}
        </p>
      )}
      {report.status === "completed" &&
        report.messages.some((message) => message.type !== "info") && (
          <p className={styles.resultNotice}>{copy.note}</p>
        )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {more && report.products.length < MAX_CATALOG_PRODUCTS && (
        <div className={styles.moreRow}>
          <button
            type="button"
            className={styles.loadMore}
            disabled={disabled}
            onClick={onLoadMore}
          >
            {loading ? copy.loading : copy.more}
          </button>
        </div>
      )}
      {more && report.products.length >= MAX_CATALOG_PRODUCTS && (
        <p className={styles.resultNotice}>{copy.limit}</p>
      )}
      {selected && (
        <ProductDetails
          product={selected}
          merchant={catalogSellerDomain(selected, report)}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}

/** Only public source links are shown; protocol diagnostics stay in the report. */
export function ShoppingSources({ report }: { report: DiscoveryReport }) {
  if (!report.sources.length && !report.searchIncomplete) {
    return null;
  }
  return (
    <div className={styles.sources}>
      {report.searchIncomplete && <p>{copy.incomplete}</p>}
      {report.sources.length > 0 && (
        <nav aria-label={copy.sources}>
          <span className={styles.sourcesLabel}>{copy.sources}</span>
          <ul>
            {report.sources.map((source) => (
              <li key={source.url}>
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                >
                  {source.title || new URL(source.url).hostname}
                  <span aria-hidden="true"> ↗</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
