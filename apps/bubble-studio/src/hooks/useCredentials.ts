import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { credentialsApi } from '../services/credentialsApi';
import type {
  CreateCredentialRequest,
  UpdateCredentialRequest,
} from '@bubblelab/shared-schemas';
import { track } from '../lib/telemetry';

export const useCredentials = (apiBaseUrl: string) => {
  return useQuery({
    queryKey: ['credentials'],
    queryFn: () => credentialsApi.getCredentials(),
    enabled: !!apiBaseUrl,
  });
};

export const useCreateCredential = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateCredentialRequest) => {
      track('credential.add_started', {
        credentialType: data.credentialType,
      });
      return credentialsApi.createCredential(data);
    },
    onSuccess: (_response, variables) => {
      track('credential.add_succeeded', {
        credentialType: variables.credentialType,
      });
      // Invalidate and refetch credentials
      queryClient.invalidateQueries({ queryKey: ['credentials'] });
    },
    onError: (error, variables) => {
      track('credential.add_failed', {
        credentialType: variables.credentialType,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
};

export const useUpdateCredential = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: UpdateCredentialRequest }) =>
      credentialsApi.updateCredential(id, data),
    onSuccess: (_response, variables) => {
      track('credential.update_succeeded', { credentialId: variables.id });
      // Invalidate and refetch credentials
      queryClient.invalidateQueries({ queryKey: ['credentials'] });
    },
    onError: (error, variables) => {
      track('credential.update_failed', {
        credentialId: variables.id,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
};

export const useDeleteCredential = (apiBaseUrl: string) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: number) => credentialsApi.deleteCredential(apiBaseUrl, id),
    onSuccess: (_response, id) => {
      track('credential.delete_succeeded', { credentialId: id });
      // Invalidate and refetch credentials
      queryClient.invalidateQueries({ queryKey: ['credentials'] });
    },
    onError: (error, id) => {
      track('credential.delete_failed', {
        credentialId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
};
