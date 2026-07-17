/**
 * Connect UI spec builder (IR-3/IR-4): turns an app's doc-derived
 * AuthMethodDescriptors into the ranked spec the Connect UI renders. The spec
 * is produced by calling each method's strategy collect() — the UI never
 * hand-maintains per-app field lists.
 *
 * `bindInferredAuthMethods` is the honesty gate between inference and the
 * registry: a descriptor can only be offered when inference derived its kind
 * from cited evidence; a binding whose kind inference did not produce throws.
 */
import type {
  AppAuthMethods,
  AuthCollectScope,
  AuthMethodDescriptor,
  AuthMethodKind,
  ConnectUiMethodOption,
  ConnectUiSpec,
  DiscoveredScopeRequirement,
} from '@bubblelab/shared-schemas';
import {
  AppAuthMethodsSchema,
  AUTH_METHOD_CONVENIENCE_RANK,
  sortByConvenience,
} from '@bubblelab/shared-schemas';
import {
  ApiKeyAuthMethod,
  BasicAuthMethod,
  ConnectionStringAuthMethod,
  MultiFieldAuthMethod,
  PatAuthMethod,
  type AuthHttpTransport,
  type AuthMethodStrategy,
} from './auth-method-strategy.js';
import { OAuth2AuthMethod } from './oauth2-strategy.js';
import type {
  AuthInferenceResult,
  InferredAuthMethod,
} from './infer-auth-methods.js';
import { AuthInferenceError } from './infer-auth-methods.js';

/** Kinds with a strategy implementation behind them. */
export const IMPLEMENTED_AUTH_KINDS: readonly AuthMethodKind[] = [
  'oauth2',
  'api_key',
  'pat',
  'basic',
  'multi_field',
  'connection_string',
];

/**
 * Construct the strategy for a descriptor. Throws for kinds that are declared
 * in the taxonomy but have no strategy yet (oauth2_jwt, browser_session,
 * xoauth2) — an unimplemented method must fail loudly, not silently no-op.
 */
export function strategyForDescriptor(
  descriptor: AuthMethodDescriptor,
  transport?: AuthHttpTransport
): AuthMethodStrategy {
  switch (descriptor.kind) {
    case 'oauth2':
      return new OAuth2AuthMethod({
        scopes: descriptor.scopes ?? [],
        testRequest: descriptor.testRequest ?? {
          url: 'about:blank',
          method: 'GET',
        },
        ...(transport !== undefined ? { transport } : {}),
      });
    case 'api_key':
    case 'pat': {
      if (!descriptor.placement || !descriptor.testRequest) {
        throw new Error(
          `${descriptor.kind} descriptor for ${descriptor.credentialType} needs placement and testRequest`
        );
      }
      const config = {
        placement: descriptor.placement,
        testRequest: descriptor.testRequest,
        ...(descriptor.secretLabel !== undefined
          ? { label: descriptor.secretLabel }
          : {}),
        ...(descriptor.secretPlaceholder !== undefined
          ? { placeholder: descriptor.secretPlaceholder }
          : {}),
        ...(transport !== undefined ? { transport } : {}),
      };
      return descriptor.kind === 'api_key'
        ? new ApiKeyAuthMethod(config)
        : new PatAuthMethod(config);
    }
    case 'basic': {
      if (!descriptor.testRequest) {
        throw new Error(
          `basic descriptor for ${descriptor.credentialType} needs a testRequest`
        );
      }
      return new BasicAuthMethod({
        testRequest: descriptor.testRequest,
        ...(transport !== undefined ? { transport } : {}),
      });
    }
    case 'multi_field': {
      if (!descriptor.fields || !descriptor.testRequest) {
        throw new Error(
          `multi_field descriptor for ${descriptor.credentialType} needs fields and testRequest`
        );
      }
      return new MultiFieldAuthMethod({
        // Placement per field is adapter-owned in BubbleLab; default to a
        // header named after the field for the strategy-level contract.
        fields: descriptor.fields.map((field) => ({
          ...field,
          placement: { in: 'header', name: field.name },
        })),
        testRequest: descriptor.testRequest,
        ...(transport !== undefined ? { transport } : {}),
      });
    }
    case 'connection_string':
      return new ConnectionStringAuthMethod({
        allowedSchemes: descriptor.allowedSchemes ?? [],
        ...(descriptor.secretLabel !== undefined
          ? { label: descriptor.secretLabel }
          : {}),
        ...(descriptor.secretPlaceholder !== undefined
          ? { placeholder: descriptor.secretPlaceholder }
          : {}),
      });
    default:
      throw new Error(
        `auth kind "${descriptor.kind}" has no strategy implementation yet (implemented: ${IMPLEMENTED_AUTH_KINDS.join(', ')})`
      );
  }
}

/**
 * Build the ranked Connect UI spec for an app. Each option's `collect` is the
 * live output of the method's strategy collect(); ordering follows
 * AUTH_METHOD_CONVENIENCE_RANK and exactly the first option is recommended.
 */
export function buildConnectUiSpec(
  bubbleName: string,
  methods: AppAuthMethods
): ConnectUiSpec {
  const parsed = AppAuthMethodsSchema.parse(methods);
  const sorted = sortByConvenience(parsed);
  const options: ConnectUiMethodOption[] = sorted.map((descriptor, index) => ({
    kind: descriptor.kind,
    credentialType: descriptor.credentialType,
    displayName: descriptor.displayName,
    ...(descriptor.description !== undefined
      ? { description: descriptor.description }
      : {}),
    rank: AUTH_METHOD_CONVENIENCE_RANK[descriptor.kind],
    recommended: index === 0,
    collect: strategyForDescriptor(descriptor).collect(),
    source: descriptor.source,
    citation: descriptor.citation,
    ...(descriptor.unverified !== undefined
      ? { unverified: descriptor.unverified }
      : {}),
  }));
  const first = options[0];
  if (first === undefined) {
    throw new Error(`app ${bubbleName} declares no auth methods`);
  }
  return { bubbleName, methods: options, recommendedKind: first.kind };
}

/**
 * Honor the user's method choice: resolve kind → descriptor + strategy.
 * The descriptor's credentialType decides which CredentialType the existing
 * credential system creates/uses, so the choice carries through storage,
 * injection, and the bubble's chooseCredential without new plumbing.
 */
export function resolveAuthChoice(
  methods: AppAuthMethods,
  kind: AuthMethodKind,
  transport?: AuthHttpTransport
): { descriptor: AuthMethodDescriptor; strategy: AuthMethodStrategy } {
  const descriptor = methods.find((method) => method.kind === kind);
  if (descriptor === undefined) {
    throw new Error(
      `this app does not offer auth kind "${kind}" (offered: ${methods.map((m) => m.kind).join(', ')})`
    );
  }
  return { descriptor, strategy: strategyForDescriptor(descriptor, transport) };
}

/** Per-app binding: attach an inferred kind to BubbleLab's credential system. */
export type AuthMethodBinding = Omit<
  AuthMethodDescriptor,
  'kind' | 'source' | 'citation' | 'confidence'
> & { kind: AuthMethodKind };

/**
 * Bind inference output to credential types. Every produced descriptor keeps
 * the inference's source/citation/confidence (the doc grounding); a binding
 * for a kind the docs did not support throws AuthInferenceError.
 */
export function bindInferredAuthMethods(
  inference: AuthInferenceResult,
  bindings: readonly AuthMethodBinding[]
): AppAuthMethods {
  const descriptors = bindings.map((binding) => {
    const inferred: InferredAuthMethod | undefined = inference.methods.find(
      (method) => method.kind === binding.kind
    );
    if (inferred === undefined) {
      throw new AuthInferenceError(
        `binding for kind "${binding.kind}" has no doc-derived support; inference produced: ${inference.methods.map((m) => m.kind).join(', ') || 'nothing'}`
      );
    }
    return {
      ...binding,
      source: inferred.source,
      citation: inferred.citation,
      confidence: inferred.confidence,
      // Doc-declared details win when the binding doesn't override them.
      ...(binding.placement === undefined && inferred.placement !== undefined
        ? { placement: inferred.placement }
        : {}),
      ...(binding.scopes === undefined && inferred.scopes !== undefined
        ? { scopes: inferred.scopes }
        : {}),
    };
  });
  return AppAuthMethodsSchema.parse(descriptors);
}

// ── Scope discovery threading (IR-6/7) ───────────────────────────────────────

/** Scope comparison key, mirroring the scope audit's normalization. */
function normalizeScope(scope: string): string {
  const trimmed = scope.trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

/**
 * Thread a flow's discovered scope requirements (per-operation `requiredScopes`, IR-8
 * metadata) into a Connect UI spec: every oauth2 method's scope picker enables EXACTLY the
 * scopes that satisfy the requirements — the consent asks for what the flow's operations
 * need, no more, no guesswork — and requirements no curated scope satisfies get an appended
 * picker entry naming the operations that need them.
 *
 * Requirement resolution per entry (all entries must hold; '|'-alternatives, any one
 * satisfies): prefer an alternative the picker already offers (picker order — the curated,
 * narrower product scope beats the broad one), else append the requirement's first declared
 * alternative as a new scope option.
 *
 * Pure and non-destructive: returns a new spec; non-oauth2 methods and specs with no
 * requirements pass through unchanged.
 */
export function applyScopeRequirementsToConnectUiSpec(
  spec: ConnectUiSpec,
  requirements: readonly DiscoveredScopeRequirement[]
): ConnectUiSpec {
  if (requirements.length === 0) return spec;
  return {
    ...spec,
    methods: spec.methods.map((method) => {
      if (method.collect.kind !== 'oauth2') return method;
      const baseScopes: AuthCollectScope[] = method.collect.scopes ?? [];
      const baseByKey = new Map(
        baseScopes.map((entry) => [normalizeScope(entry.scope), entry])
      );

      const requiredKeys = new Set<string>();
      const appended: AuthCollectScope[] = [];
      for (const requirement of requirements) {
        const satisfying = requirement.alternatives.find((alternative) =>
          baseByKey.has(normalizeScope(alternative))
        );
        if (satisfying !== undefined) {
          requiredKeys.add(normalizeScope(satisfying));
        } else {
          const fallback = requirement.alternatives[0];
          const key = normalizeScope(fallback);
          if (!requiredKeys.has(key)) {
            requiredKeys.add(key);
            appended.push({
              scope: fallback,
              description: `Required by ${requirement.requiredBy
                .map((ref) => `${ref.bubbleName}.${ref.operation}`)
                .join(', ')}`,
              defaultEnabled: true,
            });
          }
        }
      }

      const scopes: AuthCollectScope[] = [
        ...baseScopes.map((entry) => ({
          ...entry,
          defaultEnabled: requiredKeys.has(normalizeScope(entry.scope)),
        })),
        ...appended,
      ];
      return { ...method, collect: { ...method.collect, scopes } };
    }),
  };
}
