import type { PaymentStatus } from "../payment-status";

export class CheckoutError extends Error {
  constructor(
    public code: string,
    public paymentStatus?: PaymentStatus
  ) {
    super(code);
  }
}
