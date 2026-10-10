import { describe, expect, it } from 'vitest';
import { pollOnce } from './index.js';

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
});
