/**
 * CredentialRequestWidget — inline "Connect" affordance shown in the flow
 * conversation when the builder agent reports a missing credential
 * (report_missing_credential). Clicking opens the provider OAuth popup for that
 * exact credential so the user never leaves the chat to add it.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { connectCredentialViaPopup } from '../../lib/connectCredential';
import { prettyCredentialName } from '../../lib/authMethods';

export function CredentialRequestWidget({
  credentialType,
}: {
  credentialType: string;
}) {
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const name = prettyCredentialName(credentialType);

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);
    try {
      await connectCredentialViaPopup(credentialType);
      // Real result confirmed (not just "popup closed") — safe to trust now.
      queryClient.invalidateQueries({ queryKey: ['credentials'] });
      setConnected(true);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not start the connection'
      );
    } finally {
      setConnecting(false);
    }
  };

  if (connected) {
    return (
      <div className="p-3 bg-green-500/5 border border-green-500/20 rounded-lg text-[13px] text-green-300">
        {name} connected.
      </div>
    );
  }

  return (
    <div className="p-3 bg-amber-500/5 border border-amber-500/20 rounded-lg">
      <div className="text-[13px] text-gray-300 mb-2">
        This flow needs your <span className="font-medium">{name}</span>{' '}
        connection, which isn't set up yet.
      </div>
      <button
        type="button"
        onClick={() => void handleConnect()}
        disabled={connecting}
        className="px-3 py-1.5 rounded-md bg-purple-600 hover:bg-purple-500 text-white text-[13px] font-medium disabled:opacity-60"
      >
        {connecting ? 'Connecting…' : `Connect ${name}`}
      </button>
      {error && <div className="text-xs text-red-400 mt-2">{error}</div>}
    </div>
  );
}
