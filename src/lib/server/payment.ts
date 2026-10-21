import { CheckoutError } from "./checkout-error";
import { isDeepStrictEqual } from "node:util";
import { createHashtrionCredentialIssuer, HANDLER_NAME, HANDLER_VERSION } from "./payment-adapter";
import {
  assertCredentialEndpointIdentity,
  assertPaymentHandlerConsistency,
} from "./payment-handler-discovery";
import { type IssueCredential } from "./payment-credential";
import { fetchPublicJson, requestUcpJson } from "./safe-http";

export { validCredential } from "./payment-credential";
export type { Credential, CredentialContext, IssueCredential } from "./payment-credential";

// Merchant discovery selects the existing adapter; it cannot authorize arbitrary hosts.
export function createCredentialIssuer(
  request = requestUcpJson,
  now = Date.now,
  fetch = fetchPublicJson
): IssueCredential {
  return async (context) => {
    const handler = context.connection.handler;
    if (!handler || handler.name !== HANDLER_NAME || handler.version !== HANDLER_VERSION) {
      throw new CheckoutError("payment_provider_unsupported");
    }
    assertPaymentHandlerConsistency(context.connection.profileHandler, handler);
    const verified = structuredClone(handler);
    await assertCredentialEndpointIdentity(verified, context.signal, fetch);
    // The new metadata await must not allow a different runtime handler to be signed.
    if (!isDeepStrictEqual(context.connection.handler, verified)) {
      throw new CheckoutError("payment_handler_changed");
    }
    return createHashtrionCredentialIssuer(request, now)(context);
  };
}
export const issueCredential = createCredentialIssuer();
