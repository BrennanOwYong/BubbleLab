/**
 * Suite-aware credential binding (same OAuth provider, different credential type).
 *
 * For every required-credential slot that NO exact-type credential can fill but a
 * sibling-type credential of the same OAuth provider could (e.g. a Google Drive
 * credential for a Google Sheets step), this hook:
 * 1. proposes the sibling credential (`computeSuiteBindingProposals`, pure),
 * 2. verifies the credential's GRANTED scopes against the step's REQUIRED scopes
 *    via POST /credentials/:id/scope-check — the API probes Google tokeninfo live
 *    and syncs the probed grants into storage, so the check reflects the real
 *    grant, never the requested-at-authorization record alone,
 * 3. binds the credential to every step requiring the type when the scopes cover
 *    the requirements (verified), or records the missing scopes (insufficient) so
 *    FlowSetupPanel can offer incremental re-consent on the SAME credential.
 *
 * Required scopes come from flow scope discovery (`flow.scopeRequirements`); when
 * discovery found nothing for the type, the type's default OAuth scopes stand in
 * conservatively. Nothing ever binds on provider-group membership alone.
 *
 * Re-checks: `suiteRecheckNonce` (bumped after incremental re-consent completes)
 * forces a fresh probe; otherwise each (flow, type, credential, nonce) checks once.
 *
 * Telemetry: setup.suite_binding_proposed, setup.scope_check_passed,
 * setup.scope_check_insufficient.
 */
import { useEffect, useRef } from 'react';
import {
  CredentialType,
  getDefaultScopes,
  getScopeDescriptions,
} from '@bubblelab/shared-schemas';
import type { ScopeCheckRequirement } from '@bubblelab/shared-schemas';
import { useBubbleFlow } from './useBubbleFlow';
import { useCredentials } from './useCredentials';
import { getExecutionStore, useExecutionStore } from '../stores/executionStore';
import {
  computeSuiteBindingProposals,
  getBubbleKeysRequiringType,
} from '../lib/credentialBinding';
import type { SuiteBindingProposal } from '../lib/credentialBinding';
import { getAppCredentialTypes } from '../lib/authMethods';
import { emitTelemetry } from '../lib/telemetry';
import { credentialsApi } from '../services/credentialsApi';
import { API_BASE_URL } from '../env';

/**
 * The scope requirements a flow imposes on `credentialType`: discovery output
 * when present (any app-type entry carries them), else the type's default OAuth
 * scopes as single-alternative requirements (conservative stand-in so the check
 * still reflects real granted scopes instead of being skipped).
 */
export function requirementsForType(
  flowScopeRequirements: Array<{
    credentialType: string;
    requirements: Array<{ scope: string; alternatives: string[] }>;
  }>,
  credentialType: string
): {
  requirements: ScopeCheckRequirement[];
  source: 'discovery' | 'default_scopes';
} {
  const appTypes = getAppCredentialTypes(credentialType as CredentialType);
  const discovered = flowScopeRequirements.find((entry) =>
    appTypes.includes(entry.credentialType as CredentialType)
  );
  if (discovered && discovered.requirements.length > 0) {
    return {
      requirements: discovered.requirements.map((requirement) => ({
        scope: requirement.scope,
        alternatives: requirement.alternatives,
      })),
      source: 'discovery',
    };
  }
  const defaults = getDefaultScopes(credentialType as CredentialType).filter(
    // Identity scopes are always appended at authorization; requiring them here
    // would fail every pre-OIDC credential for no capability reason.
    (scope) => scope !== 'openid' && scope !== 'email'
  );
  return {
    requirements: defaults.map((scope) => ({ scope, alternatives: [scope] })),
    source: 'default_scopes',
  };
}

export function useSuiteBindings(flowId: number | null): void {
  const { data: flow } = useBubbleFlow(flowId);
  const { data: credentials = [] } = useCredentials(API_BASE_URL);
  const pendingCredentials = useExecutionStore(
    flowId,
    (state) => state.pendingCredentials
  );
  const recheckNonce = useExecutionStore(
    flowId,
    (state) => state.suiteRecheckNonce
  );
  const checkedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!flowId || !flow || credentials.length === 0) return;
    const store = getExecutionStore(flowId);

    const proposals = computeSuiteBindingProposals({
      bubbleParameters: flow.bubbleParameters ?? {},
      requiredCredentials: flow.requiredCredentials ?? {},
      pendingCredentials: store.pendingCredentials,
      credentials,
    });
    if (proposals.length === 0) return;

    // One check per required type; a verified result binds every step needing it.
    const byType = new Map<string, SuiteBindingProposal[]>();
    for (const proposal of proposals) {
      const group = byType.get(proposal.requiredCredentialType) ?? [];
      group.push(proposal);
      byType.set(proposal.requiredCredentialType, group);
    }

    for (const [credentialType, group] of byType) {
      const proposal = group[0];
      const existing = store.suiteBindings[credentialType];
      if (
        existing &&
        existing.credentialId === proposal.credentialId &&
        existing.status === 'verified'
      ) {
        continue;
      }
      const checkKey = `${flowId}:${credentialType}:${proposal.credentialId}:${recheckNonce}`;
      if (checkedRef.current.has(checkKey)) continue;
      checkedRef.current.add(checkKey);

      const bubbleKeys = group.map((entry) => entry.bubbleKey);
      emitTelemetry('setup.suite_binding_proposed', {
        flowId,
        requiredCredentialType: credentialType,
        provider: proposal.provider,
        credentialId: proposal.credentialId,
        credentialName: proposal.credentialName,
        sourceCredentialType: proposal.sourceCredentialType,
        bubbleKeys,
        candidateCount: proposal.candidateCount,
      });

      const { requirements, source: requirementSource } = requirementsForType(
        flow.scopeRequirements ?? [],
        credentialType
      );

      store.setSuiteBinding(credentialType, {
        credentialId: proposal.credentialId,
        credentialName: proposal.credentialName,
        sourceCredentialType: proposal.sourceCredentialType,
        requiredCredentialType: credentialType,
        status: 'checking',
      });

      credentialsApi
        .checkCredentialScopes(proposal.credentialId, requirements)
        .then((result) => {
          if (result.satisfied) {
            // Bind under the REQUIRED type key so validation, execution
            // injection, and the build-time scope audit all line up.
            const targetKeys = getBubbleKeysRequiringType(
              flow.bubbleParameters ?? {},
              flow.requiredCredentials ?? {},
              credentialType
            );
            for (const bubbleKey of targetKeys) {
              store.setCredential(
                bubbleKey,
                credentialType,
                proposal.credentialId
              );
            }
            store.setSuiteBinding(credentialType, {
              credentialId: proposal.credentialId,
              credentialName: proposal.credentialName,
              sourceCredentialType: proposal.sourceCredentialType,
              requiredCredentialType: credentialType,
              status: 'verified',
              grantedScopes: result.grantedScopes,
              missing: [],
              checkSource: result.source,
            });
            emitTelemetry('setup.scope_check_passed', {
              flowId,
              credentialType,
              credentialId: proposal.credentialId,
              source: result.source,
              requirementSource,
              requirementCount: requirements.length,
              grantedCount: result.grantedScopes.length,
              bubbleKeys: targetKeys,
            });
          } else {
            store.setSuiteBinding(credentialType, {
              credentialId: proposal.credentialId,
              credentialName: proposal.credentialName,
              sourceCredentialType: proposal.sourceCredentialType,
              requiredCredentialType: credentialType,
              status: 'insufficient',
              grantedScopes: result.grantedScopes,
              missing: result.missing,
              checkSource: result.source,
            });
            emitTelemetry('setup.scope_check_insufficient', {
              flowId,
              credentialType,
              credentialId: proposal.credentialId,
              source: result.source,
              requirementSource,
              missingScopes: result.missing.map((entry) => entry.scope),
            });
          }
        })
        .catch((error: unknown) => {
          store.setSuiteBinding(credentialType, {
            credentialId: proposal.credentialId,
            credentialName: proposal.credentialName,
            sourceCredentialType: proposal.sourceCredentialType,
            requiredCredentialType: credentialType,
            status: 'error',
          });
          console.warn(
            `[suite-binding] scope check failed for ${credentialType}:`,
            error
          );
        });
    }
  }, [flowId, flow, credentials, pendingCredentials, recheckNonce]);
}

/**
 * Human description for a missing scope, from the provider's scope catalogue
 * when available (falls back to the raw scope URL).
 */
export function describeMissingScope(
  credentialType: string,
  scope: string
): string {
  const catalogued = getScopeDescriptions(
    credentialType as CredentialType
  ).find((entry) => entry.scope === scope);
  return catalogued?.description ?? scope;
}
