/**
 * S7 validation gate probe for the generated fintech bubbles: factory
 * registration, params/result schema accept + reject round-trips, and class
 * instantiation for stripe-payments-api and kraken-spot-api.
 */
import {
  BubbleFactory,
  StripePaymentsApiBubble,
  KrakenSpotApiBubble,
} from '@bubblelab/bubble-core';

const factory = new BubbleFactory();
await factory.registerDefaults();

const failures: string[] = [];
const check = (label: string, pass: boolean): void => {
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${label}`);
  if (!pass) failures.push(label);
};

for (const name of ['stripe-payments-api', 'kraken-spot-api'] as const) {
  const metadata = factory.getMetadata(name);
  check(`${name} factory metadata`, metadata !== undefined);
  console.log(
    `  operations: ${Object.keys(metadata?.operationMetadata ?? {}).join(', ')}`
  );
}

const stripe = factory.get('stripe-payments-api');
check('stripe factory.get', stripe !== undefined);
check(
  'stripe accepts a valid create_payment_intent request',
  stripe!.schema.safeParse({
    operation: 'create_payment_intent',
    baseUrl: 'https://api.stripe.com',
    amount: 2000,
    currency: 'usd',
    metadata: { order_id: '6735' },
    automatic_payment_methods: { enabled: true },
  }).success
);
check(
  'stripe rejects a type-corrupted request (amount as string)',
  !stripe!.schema.safeParse({
    operation: 'create_payment_intent',
    baseUrl: 'https://api.stripe.com',
    amount: 'two thousand',
    currency: 'usd',
  }).success
);
check(
  'stripe rejects a request missing required currency',
  !stripe!.schema.safeParse({
    operation: 'create_payment_intent',
    baseUrl: 'https://api.stripe.com',
    amount: 2000,
  }).success
);
check(
  'stripe result schema accepts a payment_intent-shaped payload',
  stripe!.resultSchema.safeParse({
    operation: 'create_payment_intent',
    success: true,
    error: '',
    id: 'pi_3MtwBwLkdIwHu7ix28a3tqPa',
    object: 'payment_intent',
    amount: 2000,
    currency: 'usd',
    status: 'requires_payment_method',
  }).success
);
check(
  'stripe result schema rejects drifted payload (amount as string)',
  !stripe!.resultSchema.safeParse({
    operation: 'create_payment_intent',
    success: true,
    error: '',
    amount: '2000',
  }).success
);

const kraken = factory.get('kraken-spot-api');
check('kraken factory.get', kraken !== undefined);
check(
  'kraken accepts a valid get_ticker_information request',
  kraken!.schema.safeParse({
    operation: 'get_ticker_information',
    baseUrl: 'https://api.kraken.com/0',
    pair: 'XBTUSD',
  }).success
);
check(
  'kraken rejects a type-corrupted get_ohlc_data request (interval as string)',
  !kraken!.schema.safeParse({
    operation: 'get_ohlc_data',
    baseUrl: 'https://api.kraken.com/0',
    pair: 'XBTUSD',
    interval: 'sixty',
  }).success
);
check(
  'kraken result schema accepts a ticker-shaped result payload',
  kraken!.resultSchema.safeParse({
    operation: 'get_ticker_information',
    success: true,
    error: '',
    result: {
      XXBTZUSD: {
        a: ['30300.10000', '1', '1.000'],
        b: ['30300.00000', '1', '1.000'],
        c: ['30303.20000', '0.00067643'],
      },
    },
  }).success
);

const stripeBubble = new StripePaymentsApiBubble({
  operation: 'get_balance',
  baseUrl: 'https://api.stripe.com',
});
check(
  'stripe class instantiation',
  stripeBubble.name === 'stripe-payments-api'
);
const krakenBubble = new KrakenSpotApiBubble({
  operation: 'get_server_time',
  baseUrl: 'https://api.kraken.com/0',
});
check('kraken class instantiation', krakenBubble.name === 'kraken-spot-api');

if (failures.length > 0) {
  throw new Error(`FAIL: ${failures.length} probe(s) failed`);
}
console.log('ALL PROBES PASS');
