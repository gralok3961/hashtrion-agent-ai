# Shopping Agent — Agentic Commerce Demo

## Overview

Shopping Agent is a Next.js AI shopping application built to demonstrate **Agentic Commerce using UCP and Hashtrion's XRPL payment infrastructure**.

It shows how an AI shopping platform can discover merchant products, manage checkout, and initiate payments through an external payment provider without handling wallet private keys or executing blockchain transactions directly.

This application serves as a demonstration AI client. Hashtrion's payment infrastructure operates independently and can be integrated with other compatible commerce platforms.

## Key Features

- **Conversational Shopping:** Natural-language product discovery using the OpenAI Responses API and function calling.
- **UCP Merchant Discovery:** Discover compatible merchant services through public UCP profiles.
- **REST & MCP Catalog Search:** Retrieve actual merchant products, variants, prices, and availability. Supports Shopify Global Catalog for broader product discovery.
- **Conversational Checkout:** Select products, manage quantities, provide buyer details, and review merchant-confirmed totals.
- **Explicit Payment Confirmation:** Require user confirmation before initiating a payment.
- **Hashtrion Payment Integration:** Obtain payment credentials and complete merchant checkout using XRP or RLUSD through the Hashtrion payment rail.
- **Spending Policy Feedback:** Display payment rejection when a Wallet-defined spending limit is exceeded.
- **Safe Payment Retry:** Allow a new payment attempt after confirmed spending-policy rejection, while preserving the existing checkout.
- **Payment Status & Order Confirmation:** Display successful, pending, rejected, and uncertain payment results without automatically repeating payments.

## How It Works

1. **Product Discovery** — The AI agent discovers a merchant and searches its advertised UCP catalog using REST or MCP.
2. **Checkout** — The user selects a product and the agent prepares a merchant checkout.
3. **User Confirmation** — The user reviews the confirmed amount and payment asset before approving the purchase.
4. **Payment Credential** — The agent requests a checkout-bound credential from Hashtrion's Platform API.
5. **Payment Execution** — The merchant submits the payment through Hashtrion. The backend validates the Agent Account and Spending Policy, obtains an authorized signature, and settles on XRPL.
6. **Order Confirmation** — The application displays the merchant's confirmed order and payment result.

The agent does not hold wallet private keys, sign XRPL transactions, or directly submit blockchain payments.

## UCP Integration

The application implements selected UCP shopping capabilities using the `2026-08-25` protocol version.

- **Merchant Discovery:** `/.well-known/ucp`
- **Catalog Search:** REST and MCP
- **Checkout:** UCP REST checkout for supported merchants
- **Payment Handler:** `com.hashtrion.pay` — Hashtrion-specific XRP/RLUSD payment integration
- **Platform Profile:** Publicly exposed at the application's `/.well-known/ucp`

The Bluefern demonstration merchant supports the complete checkout and payment flow.

Shopify Global Catalog is used for broader product discovery. Discovering products through a catalog provider does not automatically enable checkout with every listed merchant.

The agent uses verified merchant-advertised endpoints rather than assuming that every merchant supports Hashtrion payments.

## Payment Authorization & Safety

Payment execution requires explicit user confirmation.

- Confirmation is bound to the selected checkout, amount, asset, and Agent Account.
- Payment credentials remain on the server and are not exposed to the AI model or browser.
- Hashtrion's backend enforces Spending Policies before payment execution.
- A confirmed `spending_limit_exceeded` rejection can be retried after the user updates the Wallet policy.
- `PENDING`, `UNKNOWN`, timeout, or uncertain payment outcomes cannot trigger another automatic payment.

Spending Policy enforcement belongs to Hashtrion's backend, not this shopping application or the XRPL protocol.

## Project Structure

| Directory | Responsibility |
|---|---|
| `src/app` | Shopping interface, chat, authentication, and public UCP profile |
| `src/lib/server` | AI orchestration, merchant discovery, catalog, checkout, and payment integration |
| `src/lib` | Shared application contracts and payment status handling |
| `scripts` | Integration verification utilities |
| `tests` | Automated tests for shopping, authentication, and payment orchestration |

## Build and Run

**Requirements**

- Node.js compatible with the project's package configuration
- OpenAI API access
- Publicly accessible UCP-compatible merchant services
- Configured Hashtrion Hackathon backend for payment execution

Install dependencies and start the application:

```bash
npm ci
npm run dev
```

Required server-side configuration includes:

| Setting | Purpose |
|---|---|
| `OPENAI_API_KEY` | OpenAI API access |
| `OPENAI_MODEL` | Configured AI model |
| `AGENT_AI_ACCESS_PASSWORD` | Demo access protection |
| `AGENT_AI_SESSION_SECRET` | Signed session authentication |
| `MERCHANT_DISCOVERY_ENABLED` | Enable merchant discovery and catalog search |
| `UCP_PLATFORM_PROFILE_URL` | This application's publicly accessible UCP profile |
| `UCP_SIGNING_PRIVATE_KEY_BASE64` | Server-side signing for authenticated integration |

Use the existing `.env.local.example` as a starting point. Keep credentials private and never commit them.

The public UCP profile must be reachable without login. The chat application requires authentication.

For HTTP request-signing details, see [HTTP-SIGNATURES.md](HTTP-SIGNATURES.md).

## Testing

Run the existing automated checks:

```bash
npm test
npm run lint
npm run build
```

The Hackathon demonstration has successfully exercised XRPL Testnet payments using **XRP and RLUSD**, including Spending Policy rejection, Wallet policy updates, and successful payment retry.

Automated tests cover merchant discovery, checkout state, payment confirmation, credential integration, error handling, and duplicate-payment protection.
