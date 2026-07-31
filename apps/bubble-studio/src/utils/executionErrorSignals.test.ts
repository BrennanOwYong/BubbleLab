/**
 * collectRunErrorSignals — the unified error detection behind the
 * "Explain with Gluu" trigger. Fixtures mirror REAL event shapes captured
 * from POST /bubble-flow/64/execute-stream (a failed google-sheets append:
 * bubble_execution_complete success:false + warn + execution_complete
 * success:true — zero error/fatal events).
 */
import { describe, expect, it } from 'vitest';
import type { StreamingLogEvent } from '@bubblelab/shared-schemas';
import {
  collectRunErrorSignals,
  composeFixRequestMessage,
  FIX_REQUEST_MARKER,
} from './executionErrorSignals';

const ts = '2026-07-30T19:59:24.750Z';

function ev(partial: Partial<StreamingLogEvent>): StreamingLogEvent {
  return { type: 'info', timestamp: ts, message: '', ...partial };
}

const failedSheetsBubble = ev({
  type: 'bubble_execution_complete',
  message: 'Bubble execution completed: google-sheets in 419ms',
  bubbleName: 'google-sheets',
  variableId: 287300,
  additionalData: {
    result: {
      success: false,
      data: {
        operation: 'append_values',
        success: false,
        error: 'Requested entity was not found.',
      },
      error: 'Requested entity was not found.',
    },
    variableId: 287300,
  },
});

const succeededRunComplete = ev({
  type: 'execution_complete',
  message: 'Execution completed successfully in 2.73s. Total cost: $0.000000',
  additionalData: {
    success: true,
    finalResult: { appended: false },
    summary: { errors: [], warnings: [{ message: 'x' }] },
  },
});

describe('collectRunErrorSignals', () => {
  it('flags a failed bubble result even with zero error/fatal events (flow-64 shape)', () => {
    const signals = collectRunErrorSignals([
      ev({ type: 'info', message: 'start' }),
      failedSheetsBubble,
      ev({
        type: 'warn',
        message: '[google-sheets] Execution did not succeed',
      }),
      succeededRunComplete,
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0].source).toBe('bubble');
    expect(signals[0].message).toContain('google-sheets');
    expect(signals[0].message).toContain('Requested entity was not found.');
  });

  it('flags error and fatal events', () => {
    const signals = collectRunErrorSignals([
      ev({ type: 'error', message: 'boom' }),
      ev({ type: 'fatal', message: 'dead' }),
    ]);
    expect(signals.map((s) => s.label)).toEqual(['ERROR', 'FATAL']);
  });

  it('flags an HTTP >= 400 response inside a successful-looking bubble result', () => {
    const signals = collectRunErrorSignals([
      ev({
        type: 'bubble_execution_complete',
        bubbleName: 'http',
        additionalData: {
          result: {
            success: true,
            data: { status: 404, statusText: 'Not Found' },
          },
        },
      }),
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0].source).toBe('http');
    expect(signals[0].message).toContain('404');
  });

  it('flags a run-level failure on execution_complete success:false', () => {
    const signals = collectRunErrorSignals([
      ev({
        type: 'execution_complete',
        message: 'Execution failed',
        additionalData: { success: false },
      }),
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0].source).toBe('run');
  });

  it('returns nothing for a clean run', () => {
    const signals = collectRunErrorSignals([
      ev({ type: 'info', message: 'start' }),
      ev({
        type: 'bubble_execution_complete',
        bubbleName: 'http',
        additionalData: { result: { success: true, data: { status: 200 } } },
      }),
      succeededRunComplete,
    ]);
    expect(signals).toHaveLength(0);
  });
});

describe('composeFixRequestMessage', () => {
  it('prefixes the fix marker and carries the bubble failure details', () => {
    const msg = composeFixRequestMessage([failedSheetsBubble]);
    expect(msg.startsWith(FIX_REQUEST_MARKER)).toBe(true);
    expect(msg).toContain('Requested entity was not found.');
    expect(msg).toContain('FAILED STEP');
  });

  it('uses provided issue details verbatim when given', () => {
    const msg = composeFixRequestMessage([], 'the summary');
    expect(msg).toContain('the summary');
    expect(msg.startsWith(FIX_REQUEST_MARKER)).toBe(true);
  });

  it('enumerates EVERY failed step when a run has multiple failures', () => {
    const failedHttpBubble = ev({
      type: 'bubble_execution_complete',
      bubbleName: 'http',
      variableId: 111,
      additionalData: {
        result: {
          success: false,
          data: { status: 400, statusText: 'Bad Request' },
          error: 'HTTP 400: Bad Request',
        },
        variableId: 111,
      },
    });
    const msg = composeFixRequestMessage([
      ev({ type: 'info', message: 'start' }),
      failedHttpBubble,
      failedSheetsBubble,
      succeededRunComplete,
    ]);
    expect(msg).toContain('2 error signals');
    expect(msg).toContain('1. FAILED STEP: Step "http" failed');
    expect(msg).toContain('2. FAILED STEP: Step "google-sheets" failed');
    expect(msg).toContain('Requested entity was not found.');
    expect(msg).toContain('Handle EVERY error above');
  });
});
