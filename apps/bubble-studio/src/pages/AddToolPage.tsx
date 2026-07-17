/**
 * Add a Tool: feed an API specification (file upload or URL), watch the
 * generation pipeline run live from streamed telemetry events, and see the
 * tool land in the Third Party Integrations catalog with its operations.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpTrayIcon,
  CheckCircleIcon,
  DocumentTextIcon,
  GlobeAltIcon,
  KeyIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { INTEGRATIONS, resolveLogoByName } from '../lib/integrations';
import { useRegisteredTools } from '../hooks/useRegisteredTools';
import { streamToolGeneration } from '../services/toolsApi';
import type {
  AuthDetectedData,
  ConfigResolvedData,
  ContractEmittedData,
  OperationClassifiedData,
  OperationFoundData,
  RegisteredTool,
  SpecParsedData,
  ToolGenEvent,
} from '../types/toolGeneration';

// ── Run state ─────────────────────────────────────────────────────────────────

interface RunState {
  phase: 'idle' | 'running' | 'done' | 'error';
  specName?: string;
  spec?: SpecParsedData;
  config?: ConfigResolvedData;
  operations: OperationFoundData[];
  classifications: Record<string, OperationClassifiedData>;
  auth?: AuthDetectedData;
  contracts: ContractEmittedData[];
  filesWritten?: string[];
  tool?: RegisteredTool;
  elapsedMs?: number;
  error?: { code: string; message: string };
}

const INITIAL_RUN: RunState = {
  phase: 'idle',
  operations: [],
  classifications: {},
  contracts: [],
};

function applyEvent(state: RunState, event: ToolGenEvent): RunState {
  switch (event.type) {
    case 'run_started':
      return {
        ...INITIAL_RUN,
        phase: 'running',
        specName: event.data.specName,
      };
    case 'spec_parsed':
      return { ...state, spec: event.data };
    case 'config_resolved':
      return { ...state, config: event.data };
    case 'operations_found':
      return { ...state, operations: event.data.operations };
    case 'operation_classified':
      return {
        ...state,
        classifications: {
          ...state.classifications,
          [event.data.name]: event.data,
        },
      };
    case 'auth_detected':
      return { ...state, auth: event.data };
    case 'contract_emitted':
      return { ...state, contracts: [...state.contracts, event.data] };
    case 'files_written':
      return { ...state, filesWritten: event.data.files };
    case 'tool_registered':
      return { ...state, tool: event.data };
    case 'generation_complete':
      return { ...state, phase: 'done', elapsedMs: event.data.elapsedMs };
    case 'generation_error':
      return { ...state, phase: 'error', error: event.data };
    default:
      return state;
  }
}

// ── Stage timeline ────────────────────────────────────────────────────────────

const STAGES: Array<{ label: string; reached: (state: RunState) => boolean }> =
  [
    { label: 'Parse specification', reached: (s) => Boolean(s.spec) },
    { label: 'Discover operations', reached: (s) => s.operations.length > 0 },
    {
      label: 'Classify read/write access',
      reached: (s) =>
        s.operations.length > 0 &&
        s.operations.every((op) => s.classifications[op.name]),
    },
    { label: 'Detect authentication', reached: (s) => Boolean(s.auth) },
    { label: 'Emit typed contracts', reached: (s) => s.contracts.length >= 5 },
    { label: 'Register tool', reached: (s) => Boolean(s.tool) },
  ];

// ── Small pieces ──────────────────────────────────────────────────────────────

function SideEffectBadge({ sideEffect }: { sideEffect: string }) {
  const isRead = sideEffect === 'read';
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide ${
        isRead
          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
          : 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
      }`}
    >
      {sideEffect}
    </span>
  );
}

function ToolChip({
  name,
  file,
  highlight,
  tooltip,
}: {
  name: string;
  file?: string;
  highlight?: boolean;
  tooltip?: string;
}) {
  return (
    <div className="relative group">
      <div
        className={`w-9 h-9 flex items-center justify-center rounded-lg border transition-all duration-200 ${
          highlight
            ? 'bg-purple-500/15 border-purple-400/60 shadow-[0_0_12px_rgba(168,85,247,0.35)]'
            : 'bg-white/5 border-white/10 hover:border-white/20 hover:bg-white/10'
        }`}
      >
        {file ? (
          <img
            src={file}
            alt={`${name} logo`}
            className="h-5 w-5"
            loading="lazy"
          />
        ) : (
          <span className="text-xs font-bold text-gray-200">
            {name.charAt(0).toUpperCase()}
          </span>
        )}
      </div>
      {highlight && (
        <span className="absolute -top-1.5 -right-1.5 px-1 rounded bg-purple-500 text-[9px] font-bold text-white">
          NEW
        </span>
      )}
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-gray-900 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-10">
        {tooltip ?? name}
      </div>
    </div>
  );
}

function CatalogStrip({ justAdded }: { justAdded?: string }) {
  const { data: registered } = useRegisteredTools();
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <p className="text-xs font-semibold tracking-wide text-gray-500 mb-3">
        Third Party Integrations
      </p>
      <div className="flex flex-wrap gap-3 items-center">
        {INTEGRATIONS.map((integration) => (
          <ToolChip
            key={integration.name}
            name={integration.name}
            file={integration.file}
          />
        ))}
        {(registered ?? []).map((tool) => (
          <ToolChip
            key={tool.name}
            name={tool.displayName}
            file={
              resolveLogoByName(tool.displayName)?.file ??
              resolveLogoByName(tool.service)?.file
            }
            highlight={tool.name === justAdded}
            tooltip={`${tool.displayName} — ${tool.operations.length} operations`}
          />
        ))}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function AddToolPage() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'upload' | 'url'>('upload');
  const [specFile, setSpecFile] = useState<File | null>(null);
  const [specUrl, setSpecUrl] = useState('');
  const [run, setRun] = useState<RunState>(INITIAL_RUN);
  const [activeContract, setActiveContract] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Reveal queue: telemetry arrives fast; drain it at a readable cadence so
  // each stage is visible as it lands. Data is untouched, only pacing.
  const queueRef = useRef<ToolGenEvent[]>([]);
  const drainingRef = useRef(false);

  useEffect(() => {
    if (!drainingRef.current) return;
    const timer = setInterval(() => {
      const next = queueRef.current.shift();
      if (!next) return;
      setRun((state) => applyEvent(state, next));
      // Structured console mirror (programmatic telemetry for tests).
      console.log(`[add-tool] ${next.type}`, 'data' in next ? next.data : '');
      if (next.type === 'tool_registered') {
        void queryClient.invalidateQueries({ queryKey: ['registered-tools'] });
      }
      if (
        next.type === 'generation_complete' ||
        next.type === 'generation_error'
      ) {
        drainingRef.current = false;
      }
    }, 350);
    return () => clearInterval(timer);
  }, [run.phase, queryClient]);

  const startRun = useCallback(async () => {
    if (run.phase === 'running') return;
    let body: { specText?: string; specUrl?: string; specFileName?: string };
    if (mode === 'upload') {
      if (!specFile) return;
      body = { specText: await specFile.text(), specFileName: specFile.name };
    } else {
      if (!specUrl.trim()) return;
      body = { specUrl: specUrl.trim() };
    }
    queueRef.current = [];
    drainingRef.current = true;
    setActiveContract(0);
    setRun({ ...INITIAL_RUN, phase: 'running' });
    try {
      await streamToolGeneration(body, (event) => {
        queueRef.current.push(event);
      });
    } catch (error) {
      queueRef.current.push({
        type: 'generation_error',
        data: {
          code: 'SPEC_URL_FETCH_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }, [mode, specFile, specUrl, run.phase]);

  const canStart =
    run.phase !== 'running' &&
    (mode === 'upload' ? Boolean(specFile) : Boolean(specUrl.trim()));

  return (
    <div className="min-h-screen bg-[#1a1a1a] text-gray-100">
      <div className="max-w-4xl mx-auto px-6 py-10 space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-semibold text-white">Add a Tool</h1>
          <p className="mt-1 text-sm text-gray-400">
            Feed a service&apos;s API specification and get typed, ready-to-use
            operations in your catalog.
          </p>
        </div>

        {/* Live catalog */}
        <CatalogStrip justAdded={run.tool?.name} />

        {/* Spec source */}
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5 space-y-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMode('upload')}
              className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                mode === 'upload'
                  ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40'
                  : 'text-gray-400 border border-white/10 hover:text-gray-200'
              }`}
            >
              <ArrowUpTrayIcon className="w-4 h-4 inline -mt-0.5 mr-1.5" />
              Upload file
            </button>
            <button
              type="button"
              onClick={() => setMode('url')}
              className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                mode === 'url'
                  ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40'
                  : 'text-gray-400 border border-white/10 hover:text-gray-200'
              }`}
            >
              <GlobeAltIcon className="w-4 h-4 inline -mt-0.5 mr-1.5" />
              From URL
            </button>
          </div>

          {mode === 'upload' ? (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full rounded-lg border border-dashed border-white/15 hover:border-purple-400/50 bg-white/[0.02] px-4 py-6 text-center transition-colors"
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".yaml,.yml,.json"
                className="hidden"
                data-testid="spec-file-input"
                onChange={(event) =>
                  setSpecFile(event.target.files?.[0] ?? null)
                }
              />
              {specFile ? (
                <span className="text-sm text-gray-200 inline-flex items-center gap-2">
                  <DocumentTextIcon className="w-5 h-5 text-purple-300" />
                  {specFile.name}
                  <span className="text-gray-500">
                    ({Math.round(specFile.size / 1024)} KB)
                  </span>
                </span>
              ) : (
                <span className="text-sm text-gray-400">
                  Click to choose a specification file (.yaml / .json)
                </span>
              )}
            </button>
          ) : (
            <input
              type="url"
              value={specUrl}
              onChange={(event) => setSpecUrl(event.target.value)}
              placeholder="https://vendor.example.com/api-spec.yaml"
              className="w-full rounded-lg bg-black/30 border border-white/10 focus:border-purple-400/60 focus:outline-none px-3 py-2.5 text-sm text-gray-100 placeholder-gray-600"
            />
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void startRun()}
              disabled={!canStart}
              data-testid="add-tool-submit"
              className={`px-5 py-2 rounded-lg text-sm font-semibold transition-colors ${
                canStart
                  ? 'bg-purple-600 hover:bg-purple-500 text-white'
                  : 'bg-white/5 text-gray-600 cursor-not-allowed'
              }`}
            >
              {run.phase === 'running' ? 'Adding…' : 'Add Tool'}
            </button>
          </div>
        </div>

        {/* Run view */}
        {run.phase !== 'idle' && (
          <div className="space-y-4" data-testid="run-view">
            {/* Stage timeline */}
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <ol className="grid grid-cols-2 md:grid-cols-3 gap-2">
                {STAGES.map((stage) => {
                  const reached = stage.reached(run);
                  return (
                    <li
                      key={stage.label}
                      className={`flex items-center gap-2 text-sm ${
                        reached ? 'text-emerald-400' : 'text-gray-500'
                      }`}
                    >
                      <CheckCircleIcon
                        className={`w-4 h-4 flex-none ${
                          reached ? 'text-emerald-400' : 'text-gray-700'
                        }`}
                      />
                      {stage.label}
                    </li>
                  );
                })}
              </ol>
            </div>

            {/* Error */}
            {run.error && (
              <div
                className="rounded-xl border border-red-500/40 bg-red-500/10 p-4 flex items-start gap-3"
                data-testid="run-error"
              >
                <ExclamationTriangleIcon className="w-5 h-5 text-red-400 flex-none mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-red-300">
                    {run.error.code}
                  </p>
                  <p className="text-sm text-red-200/80">{run.error.message}</p>
                </div>
              </div>
            )}

            {/* Spec summary */}
            {run.spec && (
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 flex flex-wrap items-center gap-x-6 gap-y-2">
                <div>
                  <p className="text-xs text-gray-500">Specification</p>
                  <p className="text-sm text-gray-200">
                    {run.spec.title}
                    {run.spec.version
                      ? ` · ${run.spec.version.startsWith('v') ? '' : 'v'}${run.spec.version}`
                      : ''}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Endpoints</p>
                  <p className="text-sm text-gray-200">{run.spec.pathCount}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Operations documented</p>
                  <p className="text-sm text-gray-200">
                    {run.spec.operationCount}
                  </p>
                </div>
                {run.config && (
                  <div>
                    <p className="text-xs text-gray-500">Tool name</p>
                    <p className="text-sm text-purple-300 font-medium">
                      {run.config.displayName}
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Operations */}
            {run.operations.length > 0 && (
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
                <p className="text-xs font-semibold tracking-wide text-gray-500 mb-3">
                  Operations
                </p>
                <table
                  className="w-full text-sm"
                  data-testid="operations-table"
                >
                  <thead>
                    <tr className="text-left text-xs text-gray-500">
                      <th className="pb-2 font-medium">Operation</th>
                      <th className="pb-2 font-medium">Endpoint</th>
                      <th className="pb-2 font-medium">Access</th>
                      <th className="pb-2 font-medium text-right">
                        Confidence
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.operations.map((operation) => {
                      const classification =
                        run.classifications[operation.name];
                      return (
                        <tr
                          key={operation.name}
                          className="border-t border-white/5"
                        >
                          <td className="py-2 pr-3">
                            <p className="text-gray-200 font-mono text-[13px]">
                              {operation.name}
                            </p>
                            {operation.summary && (
                              <p className="text-xs text-gray-500 max-w-[260px] truncate">
                                {operation.summary}
                              </p>
                            )}
                          </td>
                          <td className="py-2 pr-3 font-mono text-[12px] text-gray-400">
                            <span className="text-purple-300">
                              {operation.method}
                            </span>{' '}
                            {operation.path}
                          </td>
                          <td className="py-2 pr-3">
                            {classification ? (
                              <SideEffectBadge
                                sideEffect={classification.sideEffect}
                              />
                            ) : (
                              <span className="text-xs text-gray-600">
                                classifying…
                              </span>
                            )}
                          </td>
                          <td className="py-2 text-right text-xs text-gray-400">
                            {classification
                              ? `${Math.round(classification.confidence * 100)}%`
                              : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Auth */}
            {run.auth && (
              <div
                className="rounded-xl border border-white/10 bg-white/[0.02] p-4"
                data-testid="auth-card"
              >
                <p className="text-xs font-semibold tracking-wide text-gray-500 mb-3">
                  Authentication
                </p>
                <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
                  <div className="flex items-center gap-2">
                    <KeyIcon className="w-4 h-4 text-purple-300" />
                    <span className="text-gray-200 font-mono text-[13px]">
                      {run.auth.credentialType}
                    </span>
                    <span className="text-xs text-gray-500">
                      ({run.auth.scheme} token)
                    </span>
                  </div>
                  <div>
                    <span className="text-xs text-gray-500 mr-2">Headers</span>
                    <span className="text-gray-300 font-mono text-[12px]">
                      {run.auth.headerNames.join(', ')}
                    </span>
                  </div>
                  <div>
                    <span className="text-xs text-gray-500 mr-2">
                      Per-account
                    </span>
                    <span className="text-gray-300 font-mono text-[12px]">
                      {run.auth.baseUrlParam.name}
                    </span>
                    <span className="text-xs text-gray-600 ml-2">
                      e.g. {run.auth.baseUrlParam.example}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Typed contract preview */}
            {run.contracts.length > 0 && (
              <div
                className="rounded-xl border border-white/10 bg-white/[0.02] p-4"
                data-testid="contract-preview"
              >
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs font-semibold tracking-wide text-gray-500">
                    Typed contract
                  </p>
                  <div className="flex gap-1">
                    {run.contracts.map((contract, index) => (
                      <button
                        key={contract.fileName}
                        type="button"
                        onClick={() => setActiveContract(index)}
                        className={`px-2 py-1 rounded text-[11px] font-mono transition-colors ${
                          index === activeContract
                            ? 'bg-purple-500/20 text-purple-300'
                            : 'text-gray-500 hover:text-gray-300'
                        }`}
                      >
                        {contract.fileName}
                      </button>
                    ))}
                  </div>
                </div>
                {(() => {
                  const active = run.contracts[activeContract];
                  if (!active) return null;
                  return (
                    <div>
                      <p className="text-xs text-gray-500 mb-2">
                        {active.lines} lines ·{' '}
                        {(active.bytes / 1024).toFixed(1)} KB
                      </p>
                      {active.excerpt ? (
                        <pre className="max-h-72 overflow-auto rounded-lg bg-black/40 border border-white/5 p-3 text-[11px] leading-relaxed text-gray-300 font-mono whitespace-pre">
                          {active.excerpt}
                        </pre>
                      ) : (
                        <p className="text-xs text-gray-600">
                          Written to the tool&apos;s implementation set.
                        </p>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Done banner */}
            {run.phase === 'done' && run.tool && (
              <div
                className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4"
                data-testid="run-complete"
              >
                <div className="flex items-center gap-3">
                  <CheckCircleIcon className="w-6 h-6 text-emerald-400 flex-none" />
                  <div>
                    <p className="text-sm font-semibold text-emerald-300">
                      {run.tool.displayName} added to your catalog
                    </p>
                    <p className="text-xs text-emerald-200/70">
                      {run.tool.operations.length} typed operations ready to use
                      {run.elapsedMs
                        ? ` · generated in ${(run.elapsedMs / 1000).toFixed(1)}s`
                        : ''}
                    </p>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {run.tool.operations.map((operation) => (
                    <span
                      key={operation.name}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-xs font-mono text-gray-300"
                    >
                      {operation.name}
                      <SideEffectBadge sideEffect={operation.sideEffect} />
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
