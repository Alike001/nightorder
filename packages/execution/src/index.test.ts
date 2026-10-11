import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hashTradeInstruction,
  verifyPersistentRecords,
} from '@nightorder/domain';
import {
  type ApprovedPaperPlan,
  type PaperExecutionOptions,
  type PaperOrderRequest,
  type PaperResult,
  SqlitePaperExecutionAdapter,
} from './index.js';

const fixedNow = new Date('2026-10-10T12:00:00.000Z');
function makePlan(
  overrides: Partial<ApprovedPaperPlan> = {},
): ApprovedPaperPlan {
  const { planHash: hashOverride, ...planOverrides } = overrides;
  const instruction = {
    id: 'plan-1',
    ownerId: 'owner-1',
    symbol: 'BTCUSDT',
    side: 'BUY',
    quoteBudgetUsdt: '500',
    triggerPrice: '59000',
    triggerOperator: 'ASK_LTE',
    limitPrice: '60000',
    expiresAtUtc: '2026-10-10T13:00:00.000Z',
    timezone: 'UTC',
    mode: 'PAPER',
    ...planOverrides,
  } as const;
  return {
    ...instruction,
    planHash: hashOverride ?? hashTradeInstruction(instruction),
    approvedAtUtc: '2026-10-10T11:59:00.000Z',
    state: 'SUBMITTING',
    revision: 2,
    ...overrides,
  };
}

const planFixture: ApprovedPaperPlan = makePlan();

const requestFixture: PaperOrderRequest = {
  clientOrderId: 'nightorder-plan-1',
  planId: 'plan-1',
  symbol: 'BTCUSDT',
  side: 'BUY',
  quantity: '0.008',
  limitPrice: '60000',
};

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup(plan = planFixture) {
  const directory = mkdtempSync(join(tmpdir(), 'nightorder-paper-'));
  directories.push(directory);
  const options: PaperExecutionOptions = {
    databasePath: join(directory, 'orders.sqlite'),
    initialBalances: { BTC: '0.25', USDT: '1000' },
    now: () => fixedNow,
  };
  const plans = {
    loadPlan: async (planId: string) => (planId === plan.id ? plan : null),
  };
  return {
    adapter: new SqlitePaperExecutionAdapter(plans, options),
    options,
    plans,
  };
}

function successfulData<T>(result: PaperResult<T>): T {
  if (!result.ok) throw new Error(result.message);
  return result.data;
}

describe('SQLite paper execution adapter', () => {
  it('records an accepted NEW order durably and keeps accepted distinct from filled', async () => {
    const { adapter, options, plans } = setup();
    const submitted = await adapter.submitApprovedOrder(requestFixture);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.data.status).toBe('NEW');

    const readback = await adapter.findOrderByClientId(
      requestFixture.clientOrderId,
    );
    expect(readback).toMatchObject({
      ok: true,
      data: {
        orderId: submitted.data.orderId,
        status: 'NEW',
        filledQuantity: '0',
      },
      evidenceId: submitted.data.orderId,
    });
    expect(
      adapter.getOrderByClientId(requestFixture.clientOrderId)?.requestDigest,
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(adapter.getAttemptForPlan('plan-1')).toMatchObject({
      planId: 'plan-1',
      operationId: 'paper-order:plan-1',
      clientOrderId: requestFixture.clientOrderId,
      state: 'ACKNOWLEDGED',
      venueStatus: 'NEW',
      evidenceSource: 'ORIGINAL_PAPER',
      remoteOrderId: submitted.data.orderId,
    });
    expect(successfulData(await adapter.virtualBalances())).toEqual({
      BTC: '0.25',
      USDT: '520',
    });
    adapter.close();

    const reopened = new SqlitePaperExecutionAdapter(plans, options);
    expect(
      await reopened.findOrderByClientId(requestFixture.clientOrderId),
    ).toMatchObject({
      ok: true,
      data: {
        orderId: submitted.data.orderId,
        status: 'NEW',
        filledQuantity: '0',
      },
    });
    expect(reopened.getAttemptForPlan('plan-1')?.remoteOrderId).toBe(
      submitted.data.orderId,
    );
    reopened.close();
  });

  it('lets the independent verifier derive checks from persisted rows and explicit plan evidence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nightorder-verifier-'));
    directories.push(directory);
    const adapter = new SqlitePaperExecutionAdapter(
      {
        loadPlan: async () => planFixture,
        loadPlanEvidence: async () => ({
          evidenceId: 'persisted-plan-evidence',
          data: planFixture,
        }),
        loadAuthorizationEvidence: async () => ({
          evidenceId: 'persisted-authorization-evidence',
          data: {
            planId: planFixture.id,
            ownerId: planFixture.ownerId,
            planHash: planFixture.planHash,
            approvedAtUtc: planFixture.approvedAtUtc!,
          },
        }),
      },
      {
        databasePath: join(directory, 'orders.sqlite'),
        initialBalances: { BTC: '0.25', USDT: '1000' },
        now: () => fixedNow,
      },
    );
    try {
      const submitted = await adapter.submitApprovedOrder(requestFixture);
      expect(submitted.ok).toBe(true);
      if (!submitted.ok) return;
      const snapshot = await adapter.loadVerificationEvidence(planFixture.id);
      expect(verifyPersistentRecords(snapshot)).toMatchObject({
        result: 'VERIFIED',
        checks: {
          PLAN_HASH_MATCHES: true,
          PLAN_APPROVED: true,
          OWNER_AUTHORIZATION_MATCHES: true,
          ORDER_ATTEMPT_UNIQUE: true,
          ORDER_REQUEST_MATCHES_PLAN: true,
          EXECUTION_STATUS_MATCHES: true,
          CANCELLATION_STATE_MATCHES: true,
          PAPER_EVIDENCE_ONLY: true,
        },
      });
    } finally {
      adapter.close();
    }
  });

  it('allows at most one order per plan under concurrent submissions', async () => {
    const { adapter } = setup();
    const [first, second] = await Promise.all([
      adapter.submitApprovedOrder(requestFixture),
      adapter.submitApprovedOrder({
        ...requestFixture,
        clientOrderId: 'nightorder-plan-1-retry',
      }),
    ]);
    expect([first, second].filter((result) => result.ok)).toHaveLength(1);
    expect(adapter.countOrdersForPlan('plan-1')).toBe(1);
    expect(adapter.getAttemptForPlan('plan-1')).not.toBeNull();
    adapter.close();
  });

  it('rejects a price above the approved limit and leaves no order or reservation', async () => {
    const { adapter } = setup();
    const result = await adapter.submitApprovedOrder({
      ...requestFixture,
      limitPrice: '60000.00000001',
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'REJECTED',
      retrySafe: false,
    });
    expect(adapter.countOrdersForPlan('plan-1')).toBe(0);
    expect(successfulData(await adapter.virtualBalances())).toEqual({
      BTC: '0.25',
      USDT: '1000',
    });
    adapter.close();
  });

  it('rejects an order that exceeds the approved budget or virtual balance', async () => {
    const { adapter } = setup();
    const overBudget = await adapter.submitApprovedOrder({
      ...requestFixture,
      quantity: '0.009',
    });
    expect(overBudget).toMatchObject({ ok: false, code: 'REJECTED' });
    const lowBalancePlan = makePlan({
      id: 'plan-2',
      quoteBudgetUsdt: '2000',
    });
    const lowBalanceSetup = setup(lowBalancePlan);
    const lowBalance = await lowBalanceSetup.adapter.submitApprovedOrder({
      ...requestFixture,
      planId: 'plan-2',
      clientOrderId: 'nightorder-plan-2',
      quantity: '0.02',
    });
    expect(lowBalance).toMatchObject({
      ok: false,
      code: 'INSUFFICIENT_BALANCE',
    });
    expect(lowBalanceSetup.adapter.countOrdersForPlan('plan-2')).toBe(0);
    lowBalanceSetup.adapter.close();
    adapter.close();
  });

  it('reserves approved SELL quantity and rejects a limit below the approved minimum', async () => {
    const sellPlan = makePlan({
      id: 'sell-plan-1',
      side: 'SELL',
      quoteBudgetUsdt: undefined,
      baseQuantityBtc: '0.1',
      triggerPrice: '66000',
      triggerOperator: 'BID_GTE',
      limitPrice: '65000',
    });
    const { adapter } = setup(sellPlan);
    const sellRequest: PaperOrderRequest = {
      ...requestFixture,
      planId: 'sell-plan-1',
      clientOrderId: 'nightorder-sell-plan-1',
      side: 'SELL',
      quantity: '0.1',
      limitPrice: '64999.99999999',
    };
    expect(await adapter.submitApprovedOrder(sellRequest)).toMatchObject({
      ok: false,
      code: 'REJECTED',
    });
    const accepted = await adapter.submitApprovedOrder({
      ...sellRequest,
      limitPrice: '65000',
    });
    expect(accepted).toMatchObject({ ok: true, data: { status: 'NEW' } });
    expect(successfulData(await adapter.virtualBalances()).BTC).toBe('0.15');
    adapter.close();
  });

  it('rejects unapproved, expired and non-PAPER plans before writing', async () => {
    const { adapter } = setup({
      ...planFixture,
      mode: 'TESTNET',
    } as unknown as ApprovedPaperPlan);
    expect(await adapter.submitApprovedOrder(requestFixture)).toMatchObject({
      ok: false,
      code: 'REJECTED',
    });
    adapter.close();

    const expired = setup(
      makePlan({
        expiresAtUtc: '2026-10-10T11:00:00.000Z',
        approvedAtUtc: '2026-10-10T10:59:00.000Z',
      }),
    );
    expect(
      await expired.adapter.submitApprovedOrder(requestFixture),
    ).toMatchObject({ ok: false, code: 'EXPIRED' });
    expect(expired.adapter.countOrdersForPlan('plan-1')).toBe(0);
    expired.adapter.close();

    const unapprovedPlan = { ...planFixture };
    delete unapprovedPlan.approvedAtUtc;
    const unapproved = setup(unapprovedPlan);
    expect(
      await unapproved.adapter.submitApprovedOrder(requestFixture),
    ).toMatchObject({ ok: false, code: 'REJECTED' });
    unapproved.adapter.close();
  });

  it('rejects approval and expiry timestamps that are not valid UTC ISO values', async () => {
    for (const changedPlan of [
      { ...planFixture, expiresAtUtc: '2026-10-10T13:00:00+00:00' },
      { ...planFixture, approvedAtUtc: '2026-10-10T11:59:00-05:00' },
      { ...planFixture, expiresAtUtc: '2026-02-30T13:00:00.000Z' },
    ]) {
      const { adapter } = setup(changedPlan);
      expect(await adapter.submitApprovedOrder(requestFixture)).toMatchObject({
        ok: false,
        code: 'REJECTED',
        retrySafe: false,
      });
      expect(adapter.countOrdersForPlan('plan-1')).toBe(0);
      adapter.close();
    }
  });

  it('cancels a resting order and releases its reserved balance', async () => {
    const { adapter } = setup();
    const submitted = await adapter.submitApprovedOrder(requestFixture);
    expect(submitted.ok).toBe(true);
    expect(
      successfulData(await adapter.requestCancel(requestFixture.clientOrderId))
        .status,
    ).toBe('CANCEL_REQUESTED');
    expect(
      successfulData(
        await adapter.findOrderByClientId(requestFixture.clientOrderId),
      ).status,
    ).toBe('CANCELED');
    expect(successfulData(await adapter.virtualBalances()).USDT).toBe('1000');
    adapter.close();
  });
});
