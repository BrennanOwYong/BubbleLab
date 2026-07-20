import { api } from '../lib/api';
import type {
  CredentialResponse,
  CreateCredentialRequest,
  UpdateCredentialRequest,
  BrowserbaseSessionCreateResponse,
  BrowserbaseSessionCompleteResponse,
  BrowserbaseSessionReopenResponse,
  CredentialScopeCheckResponse,
  ScopeCheckRequirement,
} from '@bubblelab/shared-schemas';

export const credentialsApi = {
  getCredentials: async (): Promise<CredentialResponse[]> => {
    return api.get<CredentialResponse[]>('/credentials');
  },

  initiateOAuth: async (
    provider: string,
    credentialType: string,
    name?: string,
    scopes?: string[],
    credentialId?: number
  ): Promise<{ authUrl: string; state: string }> => {
    return api.post<{ authUrl: string; state: string }>(
      `/oauth/${provider}/initiate`,
      {
        credentialType,
        name,
        scopes,
        // Incremental re-consent: ADD the scopes to this existing credential
        // (the callback updates the row instead of inserting a new one).
        credentialId,
      }
    );
  },

  /**
   * Verify a credential's GRANTED scopes against scope requirements. The API
   * probes the provider live when possible (Google tokeninfo) and syncs the
   * probed grants into storage; `source` says which path answered.
   */
  checkCredentialScopes: async (
    credentialId: number,
    requirements: ScopeCheckRequirement[]
  ): Promise<CredentialScopeCheckResponse> => {
    return api.post<CredentialScopeCheckResponse>(
      `/credentials/${credentialId}/scope-check`,
      { requirements }
    );
  },

  refreshOAuthToken: async (
    credentialId: number,
    provider: string
  ): Promise<{ message: string }> => {
    return api.post<{ message: string }>(`/oauth/${provider}/refresh`, {
      credentialId,
    });
  },

  createCredential: async (
    data: CreateCredentialRequest
  ): Promise<CredentialResponse> => {
    return api.post<CredentialResponse>('/credentials', data);
  },

  updateCredential: async (
    id: number,
    data: UpdateCredentialRequest
  ): Promise<CredentialResponse> => {
    return api.put<CredentialResponse>(`/credentials/${id}`, data);
  },

  deleteCredential: async (_apiBaseUrl: string, id: number): Promise<void> => {
    return api.delete<void>(`/credentials/${id}`);
  },

  // BrowserBase session methods
  createBrowserbaseSession: async (
    credentialType: string,
    name?: string
  ): Promise<BrowserbaseSessionCreateResponse> => {
    return api.post<BrowserbaseSessionCreateResponse>(
      '/browserbase/session/create',
      { credentialType, name }
    );
  },

  completeBrowserbaseSession: async (
    sessionId: string,
    state: string,
    name?: string
  ): Promise<BrowserbaseSessionCompleteResponse> => {
    return api.post<BrowserbaseSessionCompleteResponse>(
      '/browserbase/session/complete',
      { sessionId, state, name }
    );
  },

  reopenBrowserbaseSession: async (
    credentialId: number
  ): Promise<BrowserbaseSessionReopenResponse> => {
    return api.post<BrowserbaseSessionReopenResponse>(
      '/browserbase/session/reopen',
      { credentialId }
    );
  },

  closeBrowserbaseSession: async (
    sessionId: string
  ): Promise<{ message: string }> => {
    return api.post<{ message: string }>('/browserbase/session/close', {
      sessionId,
    });
  },
};
