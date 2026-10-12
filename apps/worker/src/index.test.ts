import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteArmedPlanStore, type ArmedTradePlan } from './armed-plans.js';
import { pollOnce } from './index.js';

const testNow = () => new Date('2026-01-01T00:00:10.000Z');

function testPlan(overrides: Partial<ArmedTradePlan> = {}): ArmedTradePlan {
  return {
    id: 'plan-1',
    ownerId: 'owner-1',
    symbol: 'BTCUSDT',
    side: 'BUY',
    quoteBudgetUsdt: '25',
    triggerPrice: '100',
    triggerOperator: 'ASK_LTE',
    limitPrice: '99',
    expiresAtUtc: '2026-01-01T00:01:00.000Z',
    timezone: 'Africa/Lagos',
    mode: 'PAPER',
    planHash: 'approved-plan-hash',
    approvedAtUtc: '2025-12-31T23:00:00.000Z',
    state: 'ARMED',
    revision: 1,
    ...overrides,
  };
}

function withDatabase(run: (databasePath: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'nightorder-worker-'));
  try {
    run(join(directory, 'worker.sqlite'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function quote(ask = '99', receivedAtUtc = '2026-01-01T00:00:09.000Z') {
  return {
    symbol: 'BTCUSDT' as const,
    bestBid: '98',
    bestAsk: ask,
    observedAtUtc: receivedAtUtc,
    receivedAtUtc,
    source: 'test fixture',
    kind: 'TEST_FIXTURE' as const,
  };
}

describe('worker workspace', () => {
  it('logs stale quotes and structured errors without submitting orders', async () => {
    const messages: string[] = [];
    const port = {
      currentQuote: async () => ({
        ok: true as const,
        evidenceId: 'fixture',
        data: {
          symbol: 'BTCUSDT' as const,
          bestBid: '1',
          bestAsk: '2',
          observedAtUtc: '2026-01-01T00:00:00.000Z',
          receivedAtUtc: '2026-01-01T00:00:00.000Z',
          source: 'fixture',
          kind: 'TEST_FIXTURE' as const,
        },
      }),
    };
    await pollOnce(
      port,
      (message) => messages.push(message),
      () => new Date('2026-01-01T00:00:10.000Z'),
      1_000,
    );
    expect(messages[0]).toContain('market-data stale');

    await pollOnce(
      {
        currentQuote: async () => ({
          ok: false,
          code: 'TIMEOUT',
          message: 'timed out',
          retrySafe: true,
          evidenceId: 'x',
        }),
      },
      (message) => messages.push(message),
    );
    expect(messages[1]).toContain('market-data error code=TIMEOUT');
  });

  it('restores armed plans after restart and records a fresh trigger once', () => {
    withDatabase((databasePath) => {
      const firstProcess = new SqliteArmedPlanStore(databasePath, testNow);
      firstProcess.saveArmedPlan(testPlan());
      firstProcess.close();

      const restartedProcess = new SqliteArmedPlanStore(databasePath, testNow);
      expect(restartedProcess.listArmedPlans().map((plan) => plan.id)).toEqual([
        'plan-1',
      ]);
      expect(
        restartedProcess.evaluateQuote(quote(), 5_000).triggeredPlanIds,
      ).toEqual(['plan-1']);
      expect(
        restartedProcess.evaluateQuote(quote(), 5_000).triggeredPlanIds,
      ).toEqual([]);
      expect(restartedProcess.getState('plan-1')).toBe('TRIGGERED');
      restartedProcess.close();
    });
  });

  it('expires plans in UTC and never triggers from a stale quote', () => {
    withDatabase((databasePath) => {
      const store = new SqliteArmedPlanStore(databasePath, testNow);
      store.saveArmedPlan(
        testPlan({
          id: 'stale-plan',
          expiresAtUtc: '2026-01-01T00:00:30.000Z',
        }),
      );
      const stale = store.evaluateQuote(
        quote('99', '2026-01-01T00:00:00.000Z'),
        5_000,
      );
      expect(stale.fresh).toBe(false);
      expect(stale.triggeredPlanIds).toEqual([]);
      expect(store.getState('stale-plan')).toBe('ARMED');

      const expired = store.evaluateQuote(
        quote('99', '2026-01-01T00:00:40.000Z'),
        5_000,
        new Date('2026-01-01T00:00:45.000Z'),
      );
      expect(expired.expiredPlanIds).toEqual(['stale-plan']);
      expect(expired.triggeredPlanIds).toEqual([]);
      expect(store.getState('stale-plan')).toBe('EXPIRED');
      store.close();
    });
  });

  it('expires plans even when the quote provider returns an error', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nightorder-worker-'));
    const store = new SqliteArmedPlanStore(
      join(directory, 'worker.sqlite'),
      testNow,
    );
    try {
      store.saveArmedPlan(
        testPlan({
          id: 'offline-plan',
          expiresAtUtc: '2026-01-01T00:00:05.000Z',
        }),
      );
      await pollOnce(
        {
          currentQuote: async () => ({
            ok: false,
            code: 'NETWORK',
            message: 'offline',
            retrySafe: true,
            evidenceId: 'offline',
          }),
        },
        () => undefined,
        testNow,
        5_000,
        store,
      );
      expect(store.getState('offline-plan')).toBe('EXPIRED');
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses malformed non-UTC approval times and changed duplicate plans', () => {
    withDatabase((databasePath) => {
      const store = new SqliteArmedPlanStore(databasePath, testNow);
      expect(() =>
        store.saveArmedPlan(
          testPlan({ approvedAtUtc: '2025-12-31T23:00:00-05:00' }),
        ),
      ).toThrow('UTC timestamps');
      store.saveArmedPlan(testPlan());
      expect(() =>
        store.saveArmedPlan(testPlan({ triggerPrice: '101' })),
      ).toThrow('different contents');
      store.close();
    });
  });
});
