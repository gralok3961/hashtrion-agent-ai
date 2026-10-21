import type { CheckoutConnection } from "./checkout";
import type { CheckoutView } from "../shopping";

export type PaymentHandler = {
  name: string;
  id: string;
  version: string;
  spec?: string;
  schema?: string;
  businessId: string;
  environment: "sandbox" | "production";
  assets: string[];
  credentialEndpoint?: string;
};
export type Credential = { type: string; token: string; expiry: string };
export type CredentialContext = {
  agentId: string;
  connection: CheckoutConnection;
  checkout: CheckoutView;
  asset: string;
  idempotencyKey: string;
  signal: AbortSignal;
};
export type IssueCredential = (context: CredentialContext) => Promise<Credential>;

export function validCredential(value: unknown, now = Date.now()): value is Credential {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const c = value as Credential;
  // Provider adapters validate their specific credential type; the shared flow
  // validates only this private envelope and its remaining lifetime.
  return (
    typeof c.type === "string" &&
    /^[A-Za-z0-9_.-]{1,128}$/.test(c.type) &&
    typeof c.token === "string" &&
    c.token.length > 0 &&
    c.token.length <= 8192 &&
    !/[\s\x00-\x1f\x7f]/u.test(c.token) &&
    typeof c.expiry === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(c.expiry) &&
    Date.parse(c.expiry) > now + 5_000
  );
}
