// Contract-drift probe flow (IR-11/12 drift-signal tests).
// The probe bubble violates its declared resultSchema when payload.body.shape
// is 'drift' — simulating an upstream API changing shape mid-production.
import {
  BubbleFlow,
  ContractDriftProbeBubble,
  WebhookEvent,
} from '@bubblelab/bubble-core';

export interface Output {
  status: string;
}

export class DriftProbeFlow extends BubbleFlow<'webhook/http'> {
  async handle(payload: WebhookEvent): Promise<Output> {
    const shape =
      (payload.body as { shape?: 'conform' | 'drift' })?.shape ?? 'conform';

    const probe = new ContractDriftProbeBubble({
      operation: 'probe_read',
      shape,
    });

    const result = await probe.action();

    return { status: result.success ? 'ok' : 'failed' };
  }
}
