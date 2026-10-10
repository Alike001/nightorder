import {
  hashTradeInstruction,
  type ImmutableTradeInstruction,
  type MarketQuote,
  type TradePlan,
} from '../src/index.js';

export const BUY_INSTRUCTION: ImmutableTradeInstruction = {
  id: 'plan-001',
  ownerId: 'telegram-123',
  symbol: 'BTCUSDT',
  side: 'BUY',
  quoteBudgetUsdt: '50.000000000000000001',
  triggerPrice: '60000.000000000000000001',
  triggerOperator: 'ASK_LTE',
  limitPrice: '60000.000000000000000000',
  expiresAtUtc: '2026-10-11T06:00:00.000Z',
  timezone: 'Africa/Lagos',
  mode: 'PAPER',
};

export function draftPlan(overrides: Partial<TradePlan> = {}): TradePlan {
  const instruction = { ...BUY_INSTRUCTION, ...overrides };
  return {
    ...BUY_INSTRUCTION,
    planHash: hashTradeInstruction(instruction),
    state: 'DRAFT',
    revision: 0,
    ...overrides,
  };
}

export function armedPlan(overrides: Partial<TradePlan> = {}): TradePlan {
  const base = draftPlan();
  return {
    ...base,
    state: 'ARMED',
    approvedAtUtc: '2026-10-10T20:00:00.000Z',
    revision: 2,
    ...overrides,
  };
}

export const VALID_QUOTE: MarketQuote = {
  symbol: 'BTCUSDT',
  bestBid: '59999.999999999999999999',
  bestAsk: '60000.000000000000000001',
  observedAtUtc: '2026-10-10T20:00:00.000Z',
  receivedAtUtc: '2026-10-10T20:00:00.001Z',
  source: 'unit-test',
  kind: 'TEST_FIXTURE',
};
