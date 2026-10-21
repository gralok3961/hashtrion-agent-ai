import { isDiscoveryReport, type DiscoveryReport } from "./discovery-types";
import { isCatalogReport, type CatalogReport } from "./catalog-types";

export const MAX_MESSAGES = 40;
export const MAX_MESSAGE_LENGTH = 12_000;
export const MAX_CONVERSATION_LENGTH = 60_000;
export const MAX_REQUEST_BYTES = 384_000;

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  discovery?: DiscoveryReport;
  catalog?: CatalogReport;
  shopping?: import("./shopping").ShoppingView;
};

export function isChatHistory(
  value: unknown,
  maxCharacters = MAX_CONVERSATION_LENGTH
): value is ChatMessage[] {
  if (!Array.isArray(value) || value.length > MAX_MESSAGES) {
    return false;
  }
  let total = 0;
  return value.every((message, index) => {
    if (
      !message ||
      typeof message !== "object" ||
      message.role !== (index % 2 === 0 ? "user" : "assistant") ||
      typeof message.content !== "string" ||
      !message.content.trim() ||
      message.content.length > MAX_MESSAGE_LENGTH ||
      (message.discovery !== undefined &&
        (message.role !== "assistant" || !isDiscoveryReport(message.discovery))) ||
      (message.catalog !== undefined &&
        (message.role !== "assistant" || !isCatalogReport(message.catalog)))
    ) {
      return false;
    }
    total += message.content.length;
    return total <= maxCharacters;
  });
}
