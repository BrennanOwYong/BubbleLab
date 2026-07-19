/**
 * FU-9: credential -> step manifest. Lists every credential the current flow
 * needs, which step/bubble uses it in plain language, whether it is already
 * connected, and a one-click connect button per missing credential.
 *
 * Scope discovery (IR-6/7): the flow details carry `scopeRequirements` — the OAuth scopes
 * each credential type must cover, derived per operation from doc-grounded metadata. The
 * panel displays them ("what this tool needs and which step needs it") and threads them into
 * the Connect modal so the OAuth consent requests exactly those scopes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircleIcon, KeyIcon } from '@heroicons/react/24/outline';
import {
  CredentialType,
  CREDENTIAL_TYPE_CONFIG,
  SYSTEM_CREDENTIALS,
} from '@bubblelab/shared-schemas';
import type {
  CredentialResponse,
  CredentialScopeRequirements,
  DiscoveredScopeRequirement,
} from '@bubblelab/shared-schemas';
import { useUIStore } from '../stores/uiStore';
import { useExecutionStore, getExecutionStore } from '../stores/executionStore';
import { useBubbleFlow } from '../hooks/useBubbleFlow';
import { useCredentials, useCreateCredential } from '../hooks/useCredentials';
import { API_BASE_URL } from '../env';
import {
  describeCredentialAccount,
  getBoundCredentialIdForType,
  getBubbleKeysRequiringType,
  getCredentialsOfType,
} from '../lib/credentialBinding';
import {
  CreateCredentialModal,
  getServiceNameForCredentialType,
} from '../pages/CredentialsPage';
import { resolveLogoByName } from '../lib/integrations';
import { getAppCredentialTypes } from '../lib/authMethods';
import { emitTelemetry } from '../lib/telemetry';

/** 'slack-notification' / 'gmailSender' -> 'slack notification' / 'gmail sender' */
function humanizeStepName(key: string): string {
  return key
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
}

/** 'https://www.googleapis.com/auth/gmail.send' -> 'gmail.send' (display only). */
function shortScopeLabel(scope: string): string {
  const trimmed = scope.replace(/\/+$/, '');
  const lastSegment = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return lastSegment || trimmed;
}

/** The operations needing a requirement, in plain language. */
function describeRequiredBy(requirement: DiscoveredScopeRequirement): string {
  return requirement.requiredBy
    .map((ref) => `${ref.bubbleName}: ${ref.operation}`)
    .join(', ');
}

/** Scope comparison key, mirroring the audit's normalization (trailing-slash tolerant). */
function normalizeScope(scope: string): string {
  const trimmed = scope.trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

/** Client-side hint: is a requirement covered by the recorded grants? */
function isRequirementGranted(
  requirement: DiscoveredScopeRequirement,
  grantedScopes: string[] | undefined
): boolean | undefined {
  if (!grantedScopes || grantedScopes.length === 0) return undefined;
  const granted = new Set(grantedScopes.map(normalizeScope));
  return requirement.alternatives.some((alternative) =>
    granted.has(normalizeScope(alternative))
  );
}

interface ManifestEntry {
  credentialType: CredentialType;
  steps: string[];
  connected: boolean;
  connectedName?: string;
  /** Scope requirements this flow imposes on the credential (empty when none discovered). */
  scopeRequirements: DiscoveredScopeRequirement[];
  /** Granted scopes recorded on the connected credential, when the provider exposes them. */
  grantedScopes?: string[];
  /** Connected credentials of this exact type (the switchable accounts). */
  candidates: CredentialResponse[];
  /** pendingCredentials keys of the steps requiring this type (switch targets). */
  stepBindingKeys: string[];
  /** Credential id bound across those steps: id when they agree, null when mixed, undefined when unbound. */
  boundCredentialId: number | null | undefined;
}

export function FlowSetupPanel() {
  const flowId = useUIStore((state) => state.selectedFlowId);
  const { data: flow } = useBubbleFlow(flowId);
  const { data: credentials = [] } = useCredentials(API_BASE_URL);
  const createCredentialMutation = useCreateCredential();
  const [connectType, setConnectType] = useState<CredentialType | null>(null);
  const pendingCredentials = useExecutionStore(
    flowId,
    (state) => state.pendingCredentials
  );

  const flowScopeRequirements = useMemo<CredentialScopeRequirements[]>(
    () => flow?.scopeRequirements ?? [],
    [flow?.scopeRequirements]
  );

  // Telemetry: discovery reached the setup panel (once per flow load with requirements).
  const scopeTelemetryFlowRef = useRef<number | null>(null);
  useEffect(() => {
    if (!flowId || flowScopeRequirements.length === 0) return;
    if (scopeTelemetryFlowRef.current === flowId) return;
    scopeTelemetryFlowRef.current = flowId;
    emitTelemetry('setup.scope_requirements_discovered', {
      flowId,
      credentialTypes: flowScopeRequirements.map((entry) => ({
        credentialType: entry.credentialType,
        requirements: entry.requirements.map((requirement) => ({
          scope: requirement.scope,
          requiredBy: describeRequiredBy(requirement),
        })),
      })),
    });
  }, [flowId, flowScopeRequirements]);

  const entries = useMemo<ManifestEntry[]>(() => {
    const required = flow?.requiredCredentials ?? {};
    const byType = new Map<CredentialType, Set<string>>();
    for (const [stepKey, types] of Object.entries(required)) {
      for (const type of types ?? []) {
        if (type === CredentialType.CREDENTIAL_WILDCARD) continue;
        if (SYSTEM_CREDENTIALS.has(type)) continue;
        if (!byType.has(type)) byType.set(type, new Set());
        byType.get(type)!.add(humanizeStepName(stepKey));
      }
    }
    return [...byType.entries()].map(([credentialType, steps]) => {
      // App-level satisfaction: any method of the same app counts (a Slack
      // bot token satisfies a step that lists Slack OAuth, and vice versa).
      const appTypes = getAppCredentialTypes(credentialType);
      const match = credentials.find((cred: CredentialResponse) =>
        appTypes.includes(cred.credentialType as CredentialType)
      );
      // Scope requirements for this app: discovery lists identical requirements
      // under each credential type a bubble offers, so the first app-type hit
      // carries them all.
      const scopeEntry = flowScopeRequirements.find((entry) =>
        appTypes.includes(entry.credentialType as CredentialType)
      );
      // Account binding: exact-type accounts are switchable per flow here
      // (per step in the bubble node); the binding lives in pendingCredentials
      // under each step that requires the type.
      const candidates = getCredentialsOfType(credentials, credentialType);
      const stepBindingKeys = getBubbleKeysRequiringType(
        flow?.bubbleParameters ?? {},
        required,
        credentialType
      );
      const boundCredentialId = getBoundCredentialIdForType(
        pendingCredentials,
        stepBindingKeys,
        credentialType
      );
      return {
        credentialType,
        steps: [...steps],
        connected: !!match,
        connectedName: match?.name,
        scopeRequirements: scopeEntry?.requirements ?? [],
        grantedScopes: match?.oauthScopes,
        candidates,
        stepBindingKeys,
        boundCredentialId,
      };
    });
  }, [
    flow?.requiredCredentials,
    flow?.bubbleParameters,
    credentials,
    flowScopeRequirements,
    pendingCredentials,
  ]);

  /** Rebind every step requiring the type to the chosen account. */
  const switchAccount = (
    entry: ManifestEntry,
    toCredential: CredentialResponse,
    source: 'setup_panel' | 'connect_modal'
  ) => {
    if (!flowId || entry.stepBindingKeys.length === 0) return;
    const store = getExecutionStore(flowId);
    for (const bubbleKey of entry.stepBindingKeys) {
      store.setCredential(bubbleKey, entry.credentialType, toCredential.id);
    }
    emitTelemetry('setup.credential_switched', {
      flowId,
      credentialType: entry.credentialType,
      fromCredentialId: entry.boundCredentialId ?? null,
      toCredentialId: toCredential.id,
      toCredentialName: toCredential.name,
      bubbleKeys: entry.stepBindingKeys,
      source,
    });
  };

  /** Open the connect flow for one more account of an already-connected type. */
  const openAddAnother = (entry: ManifestEntry) => {
    emitTelemetry('setup.add_another_opened', {
      flowId,
      credentialType: entry.credentialType,
      existingCount: entry.candidates.length,
      source: 'setup_panel',
    });
    setConnectType(entry.credentialType);
  };

  /** A newly connected credential becomes the binding for its type's steps. */
  const handleCredentialCreated = (created: CredentialResponse) => {
    const entry = entries.find((candidate) =>
      getAppCredentialTypes(candidate.credentialType).includes(
        created.credentialType as CredentialType
      )
    );
    if (!entry) return;
    switchAccount(
      {
        ...entry,
        credentialType: created.credentialType as CredentialType,
        stepBindingKeys: getBubbleKeysRequiringType(
          flow?.bubbleParameters ?? {},
          flow?.requiredCredentials ?? {},
          created.credentialType
        ),
      },
      created,
      'connect_modal'
    );
  };

  if (!flowId) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center text-gray-500">
          <KeyIcon className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p className="text-sm">No flow selected</p>
          <p className="text-xs text-gray-600 mt-1">
            Select a flow to see its setup checklist
          </p>
        </div>
      </div>
    );
  }

  const missingCount = entries.filter((e) => !e.connected).length;

  return (
    <div className="h-full overflow-y-auto bg-[#1a1a1a] p-4">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-gray-100">Setup</h2>
        <p className="text-xs text-gray-400 mt-1">
          {entries.length === 0
            ? 'This flow needs no connected accounts.'
            : missingCount === 0
              ? 'Every account this flow needs is connected.'
              : `${missingCount} of ${entries.length} required connection${
                  entries.length === 1 ? '' : 's'
                } still missing.`}
        </p>
      </div>

      <div className="space-y-3">
        {entries.map((entry) => {
          const config = CREDENTIAL_TYPE_CONFIG[entry.credentialType];
          const serviceName = getServiceNameForCredentialType(
            entry.credentialType
          );
          const logo = resolveLogoByName(serviceName);
          return (
            <div
              key={entry.credentialType}
              className="bg-[#0f1115] rounded-lg border border-[#30363d] p-3"
            >
              <div className="flex items-start gap-3">
                {logo ? (
                  <img
                    src={logo.file}
                    alt={`${logo.name} logo`}
                    className="h-6 w-6 object-contain mt-0.5"
                  />
                ) : (
                  <KeyIcon className="h-6 w-6 text-gray-500 mt-0.5" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-100">
                      {config?.label ?? entry.credentialType}
                    </span>
                    {entry.connected ? (
                      <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 bg-green-500/20 text-green-300 rounded-full border border-green-500/30">
                        <CheckCircleIcon className="h-3 w-3" />
                        Connected
                        {entry.connectedName ? ` (${entry.connectedName})` : ''}
                      </span>
                    ) : (
                      <span className="text-[10px] px-2 py-0.5 bg-amber-500/20 text-amber-300 rounded-full border border-amber-500/30">
                        Needs connection
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 mt-1">
                    Used by step{entry.steps.length === 1 ? '' : 's'}:{' '}
                    {entry.steps.join(', ')}
                  </p>
                  {entry.connected && (
                    <div className="mt-2 flex items-center gap-2 flex-wrap">
                      {entry.candidates.length >= 2 ? (
                        <select
                          title={`Account used for ${entry.credentialType}`}
                          value={
                            entry.boundCredentialId !== null &&
                            entry.boundCredentialId !== undefined
                              ? String(entry.boundCredentialId)
                              : ''
                          }
                          onChange={(event) => {
                            const chosen = entry.candidates.find(
                              (candidate) =>
                                String(candidate.id) === event.target.value
                            );
                            if (chosen) {
                              switchAccount(entry, chosen, 'setup_panel');
                            }
                          }}
                          className="px-2 py-1 text-[11px] bg-neutral-800 border border-neutral-600 rounded text-gray-200 max-w-[220px]"
                        >
                          <option value="" disabled>
                            {entry.boundCredentialId === null
                              ? 'Mixed per step — pick one for all'
                              : 'Choose an account…'}
                          </option>
                          {entry.candidates.map((candidate) => (
                            <option
                              key={candidate.id}
                              value={String(candidate.id)}
                            >
                              {describeCredentialAccount(candidate)}
                            </option>
                          ))}
                        </select>
                      ) : entry.candidates.length === 1 ? (
                        <span
                          className="text-[11px] text-gray-300 truncate max-w-[220px]"
                          title="The account this flow uses. Connect another to switch."
                        >
                          Account:{' '}
                          {describeCredentialAccount(entry.candidates[0])}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => openAddAnother(entry)}
                        className="text-[11px] text-blue-300 hover:text-blue-200 underline underline-offset-2"
                      >
                        + Add another account
                      </button>
                    </div>
                  )}
                  {entry.scopeRequirements.length > 0 && (
                    <div className="mt-1.5">
                      <p className="text-[10px] text-gray-500">
                        Permissions this flow needs:
                      </p>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {entry.scopeRequirements.map((requirement) => {
                          const granted = isRequirementGranted(
                            requirement,
                            entry.connected ? entry.grantedScopes : undefined
                          );
                          const missingOnConnected =
                            entry.connected && granted === false;
                          return (
                            <span
                              key={requirement.scope}
                              title={`Needed by ${describeRequiredBy(requirement)}. Satisfied by any of: ${requirement.alternatives.join(', ')}${
                                missingOnConnected
                                  ? '. Not granted on the connected account — reconnect to grant it.'
                                  : ''
                              }`}
                              className={`text-[10px] px-1.5 py-0.5 rounded border ${
                                missingOnConnected
                                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                                  : 'bg-neutral-700/50 text-gray-300 border-neutral-600'
                              }`}
                            >
                              {shortScopeLabel(requirement.alternatives[0])}
                              {missingOnConnected ? ' ⚠' : ''}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
                {!entry.connected && (
                  <button
                    type="button"
                    onClick={() => setConnectType(entry.credentialType)}
                    className="px-3 py-1.5 bg-white text-black hover:bg-gray-200 rounded-full text-xs font-medium transition-colors flex-shrink-0"
                  >
                    Connect
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <CreateCredentialModal
        isOpen={connectType !== null}
        onClose={() => setConnectType(null)}
        onSubmit={(data) => createCredentialMutation.mutateAsync(data)}
        isLoading={createCredentialMutation.isPending}
        lockedCredentialType={connectType ?? undefined}
        flowScopeRequirements={flowScopeRequirements}
        flowId={flowId ?? undefined}
        onSuccess={handleCredentialCreated}
      />
    </div>
  );
}
