import { useQuery } from '@tanstack/react-query';
import { fetchRegisteredTools } from '@/services/toolsApi';

/** Registered (user-added) tools the integrations catalog merges in. */
export function useRegisteredTools() {
  return useQuery({
    queryKey: ['registered-tools'],
    queryFn: fetchRegisteredTools,
    staleTime: 10_000,
    retry: 1,
  });
}
