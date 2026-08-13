/**
 * Fixture seeding: create a flow (POST /bubble-flow/empty), then save its code
 * via POST /bubble-flow/validate with syncInputsWithFlow — the same two-step
 * path the studio uses, so fixtures exercise the real create/save seam.
 */
import { jsonFetch } from './api.mjs';

/**
 * Seed a fixture flow. Returns flowId. Throws with the API body on failure.
 * @param {{api:string}} stack
 * @param {{name:string, prompt:string, eventType?:string, code:string, defaultInputs?:object}} spec
 */
export async function seedFlow(stack, spec) {
  const created = await jsonFetch(stack.api, '/bubble-flow/empty', {
    method: 'POST',
    body: JSON.stringify({
      name: spec.name,
      prompt: spec.prompt,
      eventType: spec.eventType ?? 'schedule/cron',
    }),
  });
  const flowId = created.body?.id;
  if (!flowId) {
    throw new Error(
      `seedFlow: create empty flow failed (HTTP ${created.status}): ${JSON.stringify(created.body).slice(0, 300)}`
    );
  }
  const saved = await jsonFetch(stack.api, '/bubble-flow/validate', {
    method: 'POST',
    body: JSON.stringify({
      code: spec.code,
      flowId,
      options: { syncInputsWithFlow: true },
      ...(spec.defaultInputs !== undefined ? { defaultInputs: spec.defaultInputs } : {}),
    }),
  });
  const valid = saved.body?.valid === true || saved.body?.success === true;
  if (!valid) {
    throw new Error(
      `seedFlow: validate+save failed for flow ${flowId} (HTTP ${saved.status}): ${JSON.stringify(saved.body).slice(0, 500)}`
    );
  }
  return flowId;
}

/** Best-effort fixture teardown. */
export async function deleteFlow(stack, flowId) {
  try {
    await jsonFetch(stack.api, `/bubble-flow/${flowId}`, { method: 'DELETE' });
  } catch {
    /* teardown is best-effort */
  }
}
