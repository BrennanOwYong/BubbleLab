/**
 * Fetches the API's effective platform-provided credential classification
 * (GET /credentials/platform-types, S1) and publishes it to the module cache
 * every predicate call site reads (lib/platformCredentials.ts). Emits one
 * `setup.platform_credentials_loaded` telemetry event per session naming the
 * declared-SYSTEM types the server reclassified as user credentials — the
 * observable classification signal.
 */
import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SYSTEM_CREDENTIALS } from '@bubblelab/shared-schemas';
import { api } from '../lib/api';
import { setPlatformCredentialTypes } from '../lib/platformCredentials';
import { emitTelemetry } from '../lib/telemetry';

interface PlatformCredentialTypesResponse {
  platformCredentialTypes: string[];
}

let telemetryEmitted = false;

export function usePlatformCredentialTypes(): ReadonlySet<string> | undefined {
  const query = useQuery({
    queryKey: ['platform-credential-types'],
    queryFn: () =>
      api.get<PlatformCredentialTypesResponse>('/credentials/platform-types'),
    staleTime: Infinity,
  });

  const setRef = useRef<ReadonlySet<string> | undefined>(undefined);
  const types = query.data?.platformCredentialTypes;

  useEffect(() => {
    if (!types) return;
    setPlatformCredentialTypes(types);
    setRef.current = new Set(types);
    if (!telemetryEmitted) {
      telemetryEmitted = true;
      const reclassifiedAsUser = [...SYSTEM_CREDENTIALS]
        .filter((type) => !types.includes(type))
        .sort();
      emitTelemetry('setup.platform_credentials_loaded', {
        platformCredentialTypes: [...types].sort(),
        reclassifiedAsUser,
      });
    }
  }, [types]);

  if (types && !setRef.current) {
    // First render after data arrives (effect not run yet): serve the set
    // immediately so consumers never mix fallback and loaded answers.
    setRef.current = new Set(types);
    setPlatformCredentialTypes(types);
  }
  return setRef.current;
}
