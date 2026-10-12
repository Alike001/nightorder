import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashTradeInstruction, type TradePlan } from '@nightorder/domain';
import { SqliteTelegramPlanRepository } from './telegram-plan-store.js';

const NOW = '2026-10-11T20:00:00.000Z';
const EXPIRY = '2026-10-12T18:00:00.000Z';
const owner = '123456';
const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

function draft(): TradePlan {
  const instruction = {
    id: 'plan-001',
    ownerId: owner,
    symbol: 'BTCUSDT' as const,
    side: 'BUY' as const,
    quoteBudgetUsdt: '50',
    triggerPrice: '60000',
    triggerOperator: 'ASK_LTE' as const,
    limitPrice: '60000',
    expiresAtUtc: EXPIRY,
    timezone: 'Africa/Lagos',
    mode: 'PAPER' as const,
  };
  return {
    ...instruction,
    planHash: hashTradeInstruction(instruction),
    state: 'DRAFT',
    revision: 0,
  };
}

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'nightorder-plans-'));
  folders.push(folder);
  const file = join(folder, 'plans.sqlite');
  const store = new SqliteTelegramPlanRepository(file);
  return { file, store };
}

async function awaiting(store: SqliteTelegramPlanRepository) {
  const original = draft();
  await store.createDraft(original);
  const next = await store.saveTransition(
    { ...original, state: 'AWAITING_CONFIRMATION', revision: 1 },
    0,
    NOW,
  );
  if (!next.ok) throw new Error(next.message);
  return next.data;
}

async function armed(store: SqliteTelegramPlanRepository) {
  const proposed = await awaiting(store);
  const approved = await store.approveExactAtRevision(
    proposed.id,
    owner,
    proposed.planHash,
    1,
    NOW,
  );
  if (!approved.ok) throw new Error(approved.message);
  return approved.data;
}

describe('durable Telegram plan repository', () => {
  it('persists exact approved plan across restart and never claims an order', async () => {
    const { file, store } = fixture();
    const plan = await armed(store);
    expect(plan.state).toBe('ARMED');
    expect(plan.revision).toBe(2);
    await store.recordObservation(plan.id, {
      type: 'TEST_APPROVAL',
      revision: 2,
    });
    store.close();
    const reopened = new SqliteTelegramPlanRepository(file);
    expect(await reopened.loadPlan(plan.id)).toEqual(plan);
    expect(await reopened.listPlansByOwner(owner)).toHaveLength(1);
    expect(await reopened.listPlansByOwner('another-owner')).toHaveLength(0);
    expect(await reopened.loadAttempt(plan.id)).toBeNull();
    reopened.close();
  });

  it('blocks wrong owner and incorrect approval digest', async () => {
    const { store } = fixture();
    const plan = await awaiting(store);
    const unauthorized = await store.approveExactAtRevision(
      plan.id,
      '999999',
      plan.planHash,
      1,
      NOW,
    );
    expect(unauthorized).toMatchObject({ ok: false, code: 'UNAUTHORIZED' });
    const digest = await store.approveExactAtRevision(
      plan.id,
      owner,
      '0'.repeat(64),
      1,
      NOW,
    );
    expect(digest).toMatchObject({ ok: false, code: 'UNAUTHORIZED' });
    expect((await store.loadPlan(plan.id))?.state).toBe(
      'AWAITING_CONFIRMATION',
    );
    store.close();
  });

  it('rejects stale revision and a duplicate confirmation', async () => {
    const { store } = fixture();
    const plan = await armed(store);
    const duplicated = await store.approveExactAtRevision(
      plan.id,
      owner,
      plan.planHash,
      1,
      NOW,
    );
    expect(duplicated).toMatchObject({ ok: false, code: 'AMBIGUOUS' });
    const stale = await store.cancelOwnedAtRevision(plan.id, owner, 1, NOW);
    expect(stale).toMatchObject({ ok: false, code: 'AMBIGUOUS' });
    store.close();
  });

  it('cancels an armed plan but never creates a remote order', async () => {
    const { store } = fixture();
    const plan = await armed(store);
    const cancelled = await store.cancelOwnedAtRevision(
      plan.id,
      owner,
      plan.revision,
      NOW,
    );
    expect(cancelled).toMatchObject({
      ok: true,
      data: { state: 'CANCELLED', revision: 3 },
    });
    expect(await store.loadAttempt(plan.id)).toBeNull();
    store.close();
  });

  it('labels an expired armed plan EXPIRED rather than CANCELLED', async () => {
    const { store } = fixture();
    const plan = await armed(store);
    const expired = await store.cancelOwnedAtRevision(
      plan.id,
      owner,
      plan.revision,
      '2026-10-12T19:00:00.000Z',
    );
    expect(expired).toMatchObject({ ok: true, data: { state: 'EXPIRED' } });
    store.close();
  });

  it('refuses to invent a cancellation of an accepted open order', async () => {
    const { store } = fixture();
    const approved = await armed(store);
    const next = async (plan: TradePlan, state: TradePlan['state']) => {
      const result = await store.saveTransition(
        { ...plan, state, revision: plan.revision + 1 },
        plan.revision,
        NOW,
      );
      if (!result.ok) throw new Error(result.message);
      return result.data;
    };
    const triggered = await next(approved, 'TRIGGERED');
    const submitting = await next(triggered, 'SUBMITTING');
    const opened = await next(submitting, 'OPEN');
    const attempt = await store.cancelOwnedAtRevision(
      opened.id,
      owner,
      opened.revision,
      NOW,
    );
    expect(attempt).toMatchObject({ ok: false, code: 'AMBIGUOUS' });
    expect((await store.loadPlan(opened.id))?.state).toBe('OPEN');
    store.close();
  });

  it('refuses to submit when the plan is not TRIGGERED', async () => {
    const { store } = fixture();
    const approved = await armed(store);
    const claimed = await store.claimForExecution(
      approved.id,
      approved.revision,
      'operation-001',
    );
    expect(claimed).toMatchObject({ ok: false, code: 'REJECTED' });
    expect(await store.loadAttempt(approved.id)).toBeNull();
    store.close();
  });
});
