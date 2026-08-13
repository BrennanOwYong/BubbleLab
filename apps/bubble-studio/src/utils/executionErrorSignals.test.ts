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
    expect(msg).toContain('1. FAILED STEP: Step "http" (http#111) failed');
    expect(msg).toContain(
      '2. FAILED STEP: Step "google-sheets" (google-sheets#287300) failed'
    );
    expect(msg).toContain('Requested entity was not found.');
    expect(msg).toContain('Handle EVERY error above');
  });
});

/**
 * S5 — error-signal identity. The emit layer sends bubbleName === variableName
 * ("http") on every completion and the HTTP result omits the URL, so two
 * failing HTTP steps used to produce byte-identical messages. The collector
 * joins each failure to its bubble_execution START event (which carries
 * parameters.url) and resolves the real variable name from bubbleParameters.
 */
describe('S5 error-signal identity', () => {
  const startAlpha = ev({
    type: 'bubble_execution',
    message: 'Executing bubble: http',
    bubbleName: 'http',
    variableId: 111,
    additionalData: {
      parameters: { url: 'https://api.a.example/x', method: 'GET' },
      variableId: 111,
    },
  });
  const completeAlpha = ev({
    type: 'bubble_execution_complete',
    message: 'Bubble execution completed: http in 120ms',
    bubbleName: 'http',
    variableId: 111,
    additionalData: {
      result: {
        success: true,
        data: { status: 404, statusText: 'Not Found' },
      },
      variableId: 111,
    },
  });
  const startBeta = ev({
    type: 'bubble_execution',
    message: 'Executing bubble: http',
    bubbleName: 'http',
    variableId: 222,
    additionalData: {
      parameters: { url: 'https://api.b.example/y', method: 'GET' },
      variableId: 222,
    },
  });
  const completeBeta = ev({
    type: 'bubble_execution_complete',
    message: 'Bubble execution completed: http in 95ms',
    bubbleName: 'http',
    variableId: 222,
    additionalData: {
      result: {
        success: false,
        error: 'HTTP 404: Not Found',
        data: { status: 404 },
      },
      variableId: 222,
    },
  });
  const twoFailures = [startAlpha, completeAlpha, startBeta, completeBeta];
  const bubbleParameters = {
    111: { variableId: 111, variableName: 'fetchAlpha', bubbleName: 'http' },
    222: { variableId: 222, variableName: 'fetchBeta', bubbleName: 'http' },
  };

  it('two distinct failing HTTP steps produce two signals with distinct messages, URLs and variable names', () => {
    const signals = collectRunErrorSignals(twoFailures, bubbleParameters);
    expect(signals).toHaveLength(2);
    expect(signals[0].message).not.toBe(signals[1].message);
    expect(signals[0].message).toContain('https://api.a.example/x');
    expect(signals[0].message).toContain('fetchAlpha');
    expect(signals[1].message).toContain('https://api.b.example/y');
    expect(signals[1].message).toContain('fetchBeta');
  });

  it('carries machine-readable identity on each signal', () => {
    const signals = collectRunErrorSignals(twoFailures, bubbleParameters);
    expect(signals[0].variableId).toBe(111);
    expect(signals[1].variableId).toBe(222);
    expect(signals[0].url).toBe('https://api.a.example/x');
    expect(signals[1].url).toBe('https://api.b.example/y');
    expect(signals[0].variableName).toBe('fetchAlpha');
    expect(signals[1].variableName).toBe('fetchBeta');
  });

  it('stays distinct without bubbleParameters via bubbleName#variableId + joined URL', () => {
    const signals = collectRunErrorSignals(twoFailures);
    expect(signals).toHaveLength(2);
    expect(signals[0].message).not.toBe(signals[1].message);
    expect(signals[0].message).toContain('http#111');
    expect(signals[0].message).toContain('https://api.a.example/x');
    expect(signals[1].message).toContain('http#222');
    expect(signals[1].message).toContain('https://api.b.example/y');
  });

  it('composeFixRequestMessage numbers two distinguishable lines with both URLs', () => {
    const msg = composeFixRequestMessage(
      twoFailures,
      undefined,
      bubbleParameters
    );
    expect(msg).toContain('2 error signals');
    expect(msg).toContain('https://api.a.example/x');
    expect(msg).toContain('https://api.b.example/y');
    const lines = msg.split('\n');
    const line1 = lines.find((l) => l.startsWith('1. '));
    const line2 = lines.find((l) => l.startsWith('2. '));
    expect(line1).toBeTruthy();
    expect(line2).toBeTruthy();
    expect(line1).not.toBe(line2);
  });

  it('loop shape: two iterations of ONE call site each join their own start URL (nearest-preceding, consume-on-match)', () => {
    const iter2Start = ev({
      type: 'bubble_execution',
      bubbleName: 'http',
      variableId: 111,
      additionalData: {
        parameters: { url: 'https://api.a.example/second', method: 'GET' },
        variableId: 111,
      },
    });
    const iter2Complete = ev({
      type: 'bubble_execution_complete',
      bubbleName: 'http',
      variableId: 111,
      additionalData: {
        result: {
          success: false,
          error: 'HTTP 500: Internal Server Error',
          data: { status: 500 },
        },
        variableId: 111,
      },
    });
    const signals = collectRunErrorSignals([
      startAlpha,
      completeAlpha,
      iter2Start,
      iter2Complete,
    ]);
    expect(signals).toHaveLength(2);
    expect(signals[0].url).toBe('https://api.a.example/x');
    expect(signals[1].url).toBe('https://api.a.example/second');
  });

  it('a successful completion consumes its start so a later failure never inherits its URL', () => {
    const okComplete = ev({
      type: 'bubble_execution_complete',
      bubbleName: 'http',
      variableId: 111,
      additionalData: {
        result: { success: true, data: { status: 200 } },
        variableId: 111,
      },
    });
    const failStart = ev({
      type: 'bubble_execution',
      bubbleName: 'http',
      variableId: 111,
      additionalData: {
        parameters: { url: 'https://api.a.example/fails', method: 'GET' },
        variableId: 111,
      },
    });
    const failComplete = ev({
      type: 'bubble_execution_complete',
      bubbleName: 'http',
      variableId: 111,
      additionalData: {
        result: {
          success: false,
          error: 'HTTP 404: Not Found',
          data: { status: 404 },
        },
        variableId: 111,
      },
    });
    const signals = collectRunErrorSignals([
      startAlpha,
      okComplete,
      failStart,
      failComplete,
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0].url).toBe('https://api.a.example/fails');
  });
});
