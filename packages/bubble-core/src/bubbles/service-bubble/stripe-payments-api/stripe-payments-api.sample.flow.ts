import {
  BubbleFlow,
  StripePaymentsApiBubble,
  SlackBubble,
  type WebhookEvent,
} from '@bubblelab/bubble-core';

export interface Output {
  paymentLinkUrl: string;
  availableBalance: number;
  notified: boolean;
}

/**
 * Payload for the invoice-and-notify sample workflow.
 */
export interface PaymentLinkAndNotifyPayload extends WebhookEvent {
  /** Stripe Price id for the item being sold (e.g. price_123). */
  priceId: string;
  /** Quantity of the item. */
  quantity?: number;
  /** Slack channel to notify with the new payment link. */
  channel?: string;
}

/**
 * Sample workflow using the generated 'stripe-payments-api' bubble.
 *
 * Chains two Stripe operations and a notification:
 * 1. create_payment_link — mint a hosted checkout link for a price
 * 2. get_balance        — read the account's available balance
 * 3. Slack send_message — post the link + balance to a channel
 */
export class PaymentLinkAndNotifyFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: PaymentLinkAndNotifyPayload): Promise<Output> {
    // Step 1: create a payment link (write op, generated from the vendor spec)
    const link = await new StripePaymentsApiBubble({
      operation: 'create_payment_link',
      baseUrl: 'https://api.stripe.com',
      line_items: [{ price: payload.priceId, quantity: payload.quantity ?? 1 }],
    }).action();

    if (!link.success) {
      throw new Error(`create_payment_link failed: ${link.error}`);
    }

    const paymentLinkUrl = link.data?.url ?? '';

    // Step 2: read the account balance (read op, idempotent)
    const balance = await new StripePaymentsApiBubble({
      operation: 'get_balance',
      baseUrl: 'https://api.stripe.com',
    }).action();

    const availableBalance = (balance.data?.available ?? [])[0]?.amount ?? 0;

    // Step 3: notify the team
    const notify = await new SlackBubble({
      operation: 'send_message',
      channel: payload.channel ?? '#payments',
      text: `New payment link: ${paymentLinkUrl} (available balance: ${availableBalance})`,
    }).action();

    return {
      paymentLinkUrl,
      availableBalance,
      notified: notify.success,
    };
  }
}
