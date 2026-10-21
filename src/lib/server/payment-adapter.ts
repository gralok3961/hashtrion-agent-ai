import { randomUUID } from "node:crypto";
import { isAgentId } from "../agent-id";
import { isPaymentAsset } from "../shopping";
import { CheckoutError } from "./checkout-error";
import {
  validCredential,
  type CredentialContext,
  type IssueCredential,
  type PaymentHandler,
} from "./payment-credential";
import { requestUcpJson, safePublicUrl, SafeFetchError } from "./safe-http";
import { authorityUrl } from "./ucp-profile";

export const HANDLER_NAME = "com.hashtrion.pay";
export const HANDLER_VERSION = "2026-10-16";

const obj = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error();
  }
  return value as Record<string, unknown>;
};
const str = (value: unknown, max: number): string => {
  if (typeof value !== "string" || !value || value.length > max || /[\u0000-\u001f]/u.test(value)) {
    throw new Error();
  }
  return value;
};

export function parseHashtrionHandler(value: unknown): PaymentHandler | undefined {
  try {
    const h = obj(value),
      config = obj(h.config);
    if (
      h.version !== HANDLER_VERSION ||
      !["sandbox", "production"].includes(String(config.environment))
    ) {
      return;
    }
    const businessId = str(config.business_id, 100);
    if (!/^biz_[A-Za-z0-9_-]+$/.test(businessId)) {
      return;
    }
    if (!Array.isArray(h.available_instruments) || h.available_instruments.length !== 1) {
      return;
    }
    const instrument = obj(h.available_instruments[0]);
    if (instrument.type !== "digital_asset") {
      return;
    }
    const properties = obj(obj(instrument.constraints).properties);
    if (obj(properties.network).const !== "xrpl") {
      return;
    }
    const assets = obj(properties.asset).enum;
    if (
      !Array.isArray(assets) ||
      !assets.length ||
      assets.length > 256 ||
      !assets.every(isPaymentAsset)
    ) {
      return;
    }
    return {
      name: HANDLER_NAME,
      id: str(h.id, 160),
      version: HANDLER_VERSION,
      ...(h.spec !== undefined ? { spec: safePublicUrl(str(h.spec, 2048)).href } : {}),
      ...(h.schema !== undefined
        ? { schema: authorityUrl(str(h.schema, 2048), HANDLER_NAME).href }
        : {}),
      businessId,
      environment: config.environment as PaymentHandler["environment"],
      assets: [...new Set(assets)],
      ...(config.credential_endpoint !== undefined
        ? { credentialEndpoint: str(config.credential_endpoint, 2048) }
        : {}),
    };
  } catch {
    return;
  }
}

// Preparation has no network/signing side effects. It is not endpoint authorization.
export function prepareHashtrionCredentialRequest(context: CredentialContext, now = Date.now()) {
  const handler = context.connection.handler;
  if (
    !handler ||
    !isAgentId(context.agentId) ||
    !/^biz_[A-Za-z0-9_-]+$/.test(handler.businessId) ||
    !context.checkout.id ||
    context.checkout.status !== "ready_for_complete" ||
    context.checkout.errors.length ||
    !(Date.parse(context.checkout.expiresAt) > now) ||
    context.checkout.merchant !== context.connection.domain ||
    !handler.assets.includes(context.asset)
  ) {
    throw new CheckoutError("payment_context_required");
  }
  let endpoint: URL;
  try {
    endpoint = safePublicUrl(handler.credentialEndpoint ?? "");
  } catch {
    throw new CheckoutError("credential_endpoint_untrusted");
  }
  return {
    endpoint: endpoint.href,
    body: {
      agentPublicId: context.agentId,
      businessId: handler.businessId,
      checkoutId: context.checkout.id,
    },
  };
}

// Called only after the payment entry point validates provider identity and endpoint.
export function createHashtrionCredentialIssuer(
  request = requestUcpJson,
  now = Date.now
): IssueCredential {
  return async (context) => {
    const prepared = prepareHashtrionCredentialRequest(context, now());
    let response;
    try {
      response = await request(
        prepared.endpoint,
        "POST",
        prepared.body,
        {
          "Request-Id": randomUUID(),
          "UCP-Agent": `profile="${context.connection.platform}"`,
          "Idempotency-Key": context.idempotencyKey,
        },
        context.signal,
        { requireSignature: true, discardErrorBody: true, timeoutPolicy: "issue_credential" }
      );
    } catch (error) {
      if (error instanceof SafeFetchError && error.code.startsWith("signing_")) {
        throw new CheckoutError(error.code);
      }
      throw new CheckoutError("credential_request_failed");
    }
    if (response.status !== 200) {
      const code = (
        {
          400: "credential_bad_request",
          401: "credential_unauthorized",
          403: "credential_forbidden",
          500: "credential_service_unavailable",
        } as Record<number, string>
      )[response.status];
      throw new CheckoutError(code ?? "credential_request_failed");
    }
    if (
      !validCredential(response.body, now()) ||
      response.body.type !== "hashtrion_authorization"
    ) {
      throw new CheckoutError("credential_invalid");
    }
    const { type, token, expiry } = response.body;
    return { type, token, expiry };
  };
}
