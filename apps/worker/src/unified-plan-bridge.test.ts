import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashTradeInstruction, type TradePlan } from '@nightorder/domain';
import type { TelegramPlanRepository } from '@nightorder/telegram';
import {
  SqliteTradingPlanRepository,
  type IntegratedPlanRepository,
} from '@nightorder/runtime';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Telegram -> trading shared durable plan boundary', () => {
  it('shares a confirmed authorization without copying plan records', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nightorder-shared-'));
    directories.push(directory);
    const repository = new SqliteTradingPlanRepository({
      databasePath: join(directory, 'nightorder.sqlite'),
    });
    try {
      const telegram: TelegramPlanRepository = repository;
      const trading: IntegratedPlanRepository = repository;
      const instruction = {
        id: 'shared-plan-1',
        ownerId: '123456',
        symbol: 'BTCUSDT' as const,
        side: 'BUY' as const,
        quoteBudgetUsdt: '10',
        triggerPrice: '60000',
        triggerOperator: 'ASK_LTE' as const,
        limitPrice: '60000',
        expiresAtUtc: '2026-12-31T00:00:00.000Z',
        timezone: 'UTC',
        mode: 'PAPER' as const,
      };
      const draft: TradePlan = {
        ...instruction,
        state: 'DRAFT',
        revision: 0,
        planHash: hashTradeInstruction(instruction),
      };
      await telegram.createDraft(draft);
      const pending = await telegram.saveTransition(
        { ...draft, state: 'AWAITING_CONFIRMATION', revision: 1 },
        0,
        '2026-10-12T13:00:00.000Z',
      );
      expect(pending.ok).toBe(true);
      const approved = await telegram.approveExactAtRevision(
        draft.id,
        draft.ownerId,
        draft.planHash,
        1,
        '2026-10-12T13:01:00.000Z',
      );
      expect(approved.ok).toBe(true);
      if (!approved.ok) return;
      expect(approved.data.state).toBe('ARMED');
      const seenByTrading = await trading.listPlansByOwner(draft.ownerId);
      expect(seenByTrading).toHaveLength(1);
      expect(seenByTrading[0]?.planHash).toBe(draft.planHash);
      expect(seenByTrading[0]?.state).toBe('ARMED');
    } finally {
      repository.close();
    }
  });
});
