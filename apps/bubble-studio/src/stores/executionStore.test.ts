/**
 * Credential slot semantics of the execution store: merge-not-replace on
 * server round-trips, deliberate-clear suppression, and the re-assert
 * contract useAutoBindCredentials builds on (an externally wiped slot is
 * re-fillable; a user-cleared slot is not).
 */
import { describe, it, expect } from 'vitest';
import { CredentialType } from '@bubblelab/shared-schemas';
import type {
  CredentialResponse,
  ParsedBubbleWithInfo,
} from '@bubblelab/shared-schemas';
import { getExecutionStore } from './executionStore';
import { computeAutoBindings } from '../lib/credentialBinding';

// Store instances are module-level singletons per flowId; every test uses its
// own id so state never leaks between tests.
let nextFlowId = 9000;
function freshStore() {
  return getExecutionStore(nextFlowId++);
}

const GMAIL = CredentialType.GMAIL_CRED as string;
const TELEGRAM = CredentialType.TELEGRAM_BOT_TOKEN as string;

describe('mergeCredentials (server round-trips never drop selections)', () => {
  it('keeps a bound slot when the server response carries no credentials', () => {
    const store = freshStore();
    store.setCredential('5', GMAIL, 4);
    store.mergeCredentials({});
    expect(getExecutionStore(nextFlowId - 1).pendingCredentials['5']).toEqual({
      [GMAIL]: 4,
    });
  });

  it('lets a server value win its slot while unrelated slots survive', () => {
    const store = freshStore();
    store.setCredential('5', GMAIL, 4);
    store.setCredential('6', TELEGRAM, 2);
    store.mergeCredentials({ '5': { [GMAIL]: 7 } });
    const state = getExecutionStore(nextFlowId - 1);
    expect(state.pendingCredentials['5']).toEqual({ [GMAIL]: 7 });
    expect(state.pendingCredentials['6']).toEqual({ [TELEGRAM]: 2 });
  });

  it('does not resurrect a slot the user cleared (suppressed)', () => {
    const store = freshStore();
    store.setCredential('5', GMAIL, 4);
    getExecutionStore(nextFlowId - 1).setCredential('5', GMAIL, null);
    getExecutionStore(nextFlowId - 1).mergeCredentials({ '5': { [GMAIL]: 4 } });
    expect(
      getExecutionStore(nextFlowId - 1).pendingCredentials['5'][GMAIL]
    ).toBeUndefined();
  });
});

describe('deliberate-clear suppression vs external wipes', () => {
  it('setCredential(null) suppresses the slot; a fresh selection lifts it', () => {
    const store = freshStore();
    const flowId = nextFlowId - 1;
    store.setCredential('5', GMAIL, 4);
    getExecutionStore(flowId).setCredential('5', GMAIL, null);
    expect(
      getExecutionStore(flowId).suppressedAutoBindSlots.has(`5:${GMAIL}`)
    ).toBe(true);
    getExecutionStore(flowId).setCredential('5', GMAIL, 9);
    expect(
      getExecutionStore(flowId).suppressedAutoBindSlots.has(`5:${GMAIL}`)
    ).toBe(false);
  });

  it('setAllCredentials (external wipe) does not suppress anything', () => {
    const store = freshStore();
    const flowId = nextFlowId - 1;
    store.setCredential('5', GMAIL, 4);
    getExecutionStore(flowId).setAllCredentials({});
    expect(getExecutionStore(flowId).pendingCredentials['5']).toBeUndefined();
    expect(getExecutionStore(flowId).suppressedAutoBindSlots.size).toBe(0);
  });
});

describe('re-assert contract (store + computeAutoBindings, as the hook wires them)', () => {
  const gmailCredential = {
    id: 4,
    name: 'Work Gmail',
    credentialType: CredentialType.GMAIL_CRED,
    createdAt: '2026-07-01T00:00:00.000Z',
  } as unknown as CredentialResponse;
  const flowShape = {
    bubbleParameters: {
      '5': {
        variableId: 5,
        variableName: 'gmail_5',
        bubbleName: 'gmail',
        parameters: [],
      } as unknown as ParsedBubbleWithInfo,
    },
    requiredCredentials: { '5': [CredentialType.GMAIL_CRED] },
    credentials: [gmailCredential],
  };

  function hookPassBindings(flowId: number) {
    const state = getExecutionStore(flowId);
    return computeAutoBindings({
      ...flowShape,
      pendingCredentials: state.pendingCredentials,
    }).filter(
      (binding) =>
        !state.suppressedAutoBindSlots.has(
          `${binding.bubbleKey}:${binding.credentialType}`
        )
    );
  }

  it('re-fills a slot an external wipe emptied', () => {
    const store = freshStore();
    const flowId = nextFlowId - 1;
    store.setCredential('5', GMAIL, 4);
    expect(hookPassBindings(flowId)).toEqual([]);

    getExecutionStore(flowId).setAllCredentials({});
    const bindings = hookPassBindings(flowId);
    expect(bindings).toHaveLength(1);
    expect(bindings[0].credentialId).toBe(4);
  });

  it('leaves a user-cleared slot empty', () => {
    const store = freshStore();
    const flowId = nextFlowId - 1;
    store.setCredential('5', GMAIL, 4);
    getExecutionStore(flowId).setCredential('5', GMAIL, null);
    expect(hookPassBindings(flowId)).toEqual([]);
  });
});
