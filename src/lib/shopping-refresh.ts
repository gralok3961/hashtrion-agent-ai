import type { ShoppingView } from "./shopping";

export class ShoppingRefreshError extends Error {
  constructor(public readonly status: number) {
    super("Checkout refresh unavailable.");
  }
}

// Reuse the authenticated, conversation-locked status action. It only reads the
// merchant checkout; it cannot issue credentials or execute Complete Checkout.
export async function refreshShoppingStatus(
  conversationId: string,
  checkoutId: string,
  agentId: string,
  signal: AbortSignal,
  request: typeof fetch = fetch
): Promise<ShoppingView> {
  const response = await request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationId,
      ...(agentId ? { agentId } : {}),
      action: { type: "status" },
      messages: [{ role: "user", content: "Check my checkout status." }],
    }),
    signal,
  });
  if (!response.ok) {
    throw new ShoppingRefreshError(response.status);
  }
  const result = await response.json();
  const view = result.message?.shopping;
  if (
    result.conversationId !== conversationId ||
    view?.checkout?.id !== checkoutId ||
    ![
      "review",
      "processing",
      "uncertain",
      "completed",
      "canceled",
      "failed",
      "unavailable",
    ].includes(view.stage)
  ) {
    throw new ShoppingRefreshError(502);
  }
  return view;
}
