import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ApprovedPaperPlan,
  type PaperExecutionOptions,
  type PaperOrderRequest,
  type PaperResult,
  SqlitePaperExecutionAdapter,
} from './index.js';

const fixedNow = new Date('2026-10-10T12:00:00.000Z');
const planFixture: ApprovedPaperPlan = {
  id: 'plan-1',
  symbol: 'BTCUSDT',
  side: 'BUY',
  quoteBudgetUsdt: '500',
  limitPrice: '60000',
  expiresAtUtc: '2026-10-10T13:00:00.000Z',
  mode: 'PAPER',
  planHash: 'approved-digest-fixture',
  approvedAtUtc: '2026-10-10T11:59:00.000Z',
  state: 'SUBMITTING',
};

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
      orderId: submitted.data.orderId,
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
    expect(reopened.getAttemptForPlan('plan-1')?.orderId).toBe(
      submitted.data.orderId,
    );
    reopened.close();
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
    const lowBalancePlan = {
      ...planFixture,
      id: 'plan-2',
      quoteBudgetUsdt: '2000',
    } as ApprovedPaperPlan;
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
    const sellPlan: ApprovedPaperPlan = {
      id: 'sell-plan-1',
      symbol: 'BTCUSDT',
      side: 'SELL',
      baseQuantityBtc: '0.1',
      limitPrice: '65000',
      expiresAtUtc: '2026-10-10T13:00:00.000Z',
      mode: 'PAPER',
      planHash: 'approved-sell-digest-fixture',
      approvedAtUtc: '2026-10-10T11:59:00.000Z',
      state: 'SUBMITTING',
    };
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
    const { adapter } = setup({ ...planFixture, mode: 'TESTNET' });
    expect(await adapter.submitApprovedOrder(requestFixture)).toMatchObject({
      ok: false,
      code: 'REJECTED',
    });
    adapter.close();

    const expired = setup({
      ...planFixture,
      expiresAtUtc: '2026-10-10T11:00:00.000Z',
    });
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

  it('cancels a resting order and releases its reserved balance', async () => {
    const { adapter } = setup();
    const submitted = await adapter.submitApprovedOrder(requestFixture);
    expect(submitted.ok).toBe(true);
    expect(
      successfulData(await adapter.requestCancel(requestFixture.clientOrderId))
        .status,
    ).toBe('CANCELED');
    expect(
      successfulData(
        await adapter.findOrderByClientId(requestFixture.clientOrderId),
      ).status,
    ).toBe('CANCELED');
    expect(successfulData(await adapter.virtualBalances()).USDT).toBe('1000');
    adapter.close();
  });
});
