import type { InitOptions, TraceOptions } from 'neatlogs';
import { describe, expect, it } from 'vitest';
import {
  NeatlogsTraceSink,
  initializeNeatlogs,
  nightOrderTelemetryMask,
  pseudonymizePlanId,
  sanitizeTraceAttributes,
  type NeatlogsSdkBoundary,
  type TraceAttributeValue,
} from '../src/index.js';

class FakeSdk implements NeatlogsSdkBoundary {
  readonly initCalls: InitOptions[] = [];
  readonly traceCalls: TraceOptions[] = [];
  readonly traceResults: unknown[] = [];
  readonly attributes: Record<string, TraceAttributeValue>[] = [];
  flushCalls = 0;
  shutdownCalls = 0;
  initFails = false;
  flushFails = false;
  traceMode: 'OK' | 'FAIL_BEFORE' | 'FAIL_AFTER' | 'SKIP' = 'OK';

  async init(options: InitOptions): Promise<void> {
    this.initCalls.push(options);
    if (this.initFails) throw new Error('fixture init failure');
  }

  async trace<T>(
    options: TraceOptions,
    operation: (span: {
      setAttribute(name: string, value: TraceAttributeValue): unknown;
    }) => T | Promise<T>,
  ): Promise<T> {
    this.traceCalls.push(options);
    if (this.traceMode === 'FAIL_BEFORE') {
      throw new Error('fixture trace failure');
    }
    if (this.traceMode === 'SKIP') return undefined as T;
    const attributes: Record<string, TraceAttributeValue> = {};
    this.attributes.push(attributes);
    const result = await operation({
      setAttribute(name, value) {
        attributes[name] = value;
      },
    });
    this.traceResults.push(result);
    if (this.traceMode === 'FAIL_AFTER') {
      throw new Error('fixture export failure');
    }
    return result;
  }

  async flush(): Promise<boolean> {
    this.flushCalls += 1;
    if (this.flushFails) throw new Error('fixture flush failure');
    return true;
  }

  async shutdown(): Promise<boolean> {
    this.shutdownCalls += 1;
    return true;
  }
}

describe('Neatlogs lifecycle', () => {
  it('stays disabled without a key and never initializes the SDK', async () => {
    const sdk = new FakeSdk();
    const runtime = await initializeNeatlogs({}, sdk);
    expect(runtime.state).toBe('DISABLED');
    expect(sdk.initCalls).toHaveLength(0);
    expect(await runtime.flush()).toBe(true);
    expect(await runtime.shutdown()).toBe(true);
  });

  it('initializes genuine configuration once and drains on shutdown', async () => {
    const sdk = new FakeSdk();
    const runtime = await initializeNeatlogs(
      {
        apiKey: 'fixture-key-not-exported',
        workflowName: 'nightorder-test',
        environment: 'test',
      },
      sdk,
    );
    expect(runtime.state).toBe('READY');
    expect(sdk.initCalls).toHaveLength(1);
    expect(sdk.initCalls[0]).toMatchObject({
      workflowName: 'nightorder-test',
      captureLogs: false,
      registerShutdownHandlers: false,
      tags: ['nightorder', 'paper-only'],
    });
    expect(await runtime.shutdown()).toBe(true);
    expect(await runtime.shutdown()).toBe(true);
    expect(sdk.flushCalls).toBe(1);
    expect(sdk.shutdownCalls).toBe(1);
  });

  it('fails open for the application when initialization fails', async () => {
    const sdk = new FakeSdk();
    sdk.initFails = true;
    const phases: string[] = [];
    const runtime = await initializeNeatlogs(
      {
        apiKey: 'fixture-key',
        telemetryFailure: (phase) => phases.push(phase),
      },
      sdk,
    );
    expect(runtime.state).toBe('FAILED');
    expect(phases).toEqual(['initialize']);
  });

  it('still shuts down SDK resources when flushing fails', async () => {
    const sdk = new FakeSdk();
    const phases: string[] = [];
    const runtime = await initializeNeatlogs(
      {
        apiKey: 'fixture-key',
        telemetryFailure: (phase) => phases.push(phase),
      },
      sdk,
    );
    sdk.flushFails = true;
    expect(await runtime.shutdown()).toBe(false);
    expect(sdk.shutdownCalls).toBe(1);
    expect(phases).toEqual(['flush']);
  });
});

describe('safe semantic spans', () => {
  it.each(['FAIL_BEFORE', 'FAIL_AFTER'] as const)(
    'executes business logic once when telemetry mode is %s',
    async (traceMode) => {
      const sdk = new FakeSdk();
      sdk.traceMode = traceMode;
      const sink = new NeatlogsTraceSink(sdk);
      let calls = 0;
      const result = await sink.runSpan(
        { name: 'workflow', kind: 'WORKFLOW', runId: 'run-1' },
        async () => {
          calls += 1;
          return 'business-result';
        },
      );
      expect(result).toBe('business-result');
      expect(calls).toBe(1);
    },
  );

  it('runs business logic when a malformed telemetry boundary skips its callback', async () => {
    const sdk = new FakeSdk();
    sdk.traceMode = 'SKIP';
    const sink = new NeatlogsTraceSink(sdk);
    let calls = 0;
    expect(
      await sink.runSpan(
        { name: 'workflow', kind: 'WORKFLOW', runId: 'run-1' },
        async () => {
          calls += 1;
          return 'business-result';
        },
      ),
    ).toBe('business-result');
    expect(calls).toBe(1);
  });

  it('preserves application failures instead of hiding them as telemetry errors', async () => {
    const sink = new NeatlogsTraceSink(new FakeSdk());
    await expect(
      sink.runSpan(
        { name: 'workflow', kind: 'WORKFLOW', runId: 'run-1' },
        async () => {
          throw new Error('application failure');
        },
      ),
    ).rejects.toThrow('application failure');
  });

  it('does not return private business output to the SDK callback', async () => {
    const sdk = new FakeSdk();
    const sink = new NeatlogsTraceSink(sdk);
    const result = await sink.runSpan(
      { name: 'workflow', kind: 'WORKFLOW', runId: 'run-1' },
      async () => ({ text: 'private Telegram reply' }),
    );
    expect(result).toEqual({ text: 'private Telegram reply' });
    expect(sdk.traceResults).toEqual([undefined]);
  });

  it('sets semantic tool and guardrail attributes with run correlation', async () => {
    const sdk = new FakeSdk();
    const sink = new NeatlogsTraceSink(sdk);
    await sink.record({
      name: 'approve',
      kind: 'GUARDRAIL',
      runId: 'run-1',
      pseudonymousPlanId: 'plan_abc',
      attributes: { passed: false },
    });
    expect(sdk.traceCalls[0]).toMatchObject({
      name: 'approve',
      kind: 'GUARDRAIL',
    });
    expect(sdk.attributes[0]).toMatchObject({
      nightorder_run_id: 'run-1',
      nightorder_plan_id: 'plan_abc',
      'neatlogs.guardrail.passed': false,
    });
  });

  it('drops sensitive attribute names and masks secret-shaped values', () => {
    expect(
      sanitizeTraceAttributes({
        apiKey: 'not-safe',
        conversation: 'private text',
        reasoning: 'private reasoning',
        safe_code: 'Bearer secret-token',
        state: 'ARMED',
      }),
    ).toEqual({ safe_code: '[REDACTED]', state: 'ARMED' });
    expect(
      nightOrderTelemetryMask({
        attributes: {
          authorization: 'Bearer secret-token',
          state: 'ARMED',
        },
      }),
    ).toEqual({
      attributes: { authorization: '[REDACTED]', state: 'ARMED' },
    });
  });

  it('generates a stable pseudonym without exposing the plan ID', () => {
    const planId = 'private-plan-123';
    const pseudonym = pseudonymizePlanId(planId);
    expect(pseudonym).toBe(pseudonymizePlanId(planId));
    expect(pseudonym).not.toContain(planId);
    expect(pseudonym).toMatch(/^plan_[a-f0-9]{24}$/);
  });
});
