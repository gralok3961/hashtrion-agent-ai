import { handleCatalogPage } from "@/lib/server/catalog-pagination";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleCatalogPage(request);
}
