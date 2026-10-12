import { describe, expect, it, vi } from 'vitest';
import {
  classifyQuoteFreshness,
  createBinanceSpotMarketDataPort,
  isQuoteFresh,
  quoteAgeMs,
  type MarketQuote,
} from './index.js';

const quote: MarketQuote = {
  symbol: 'BTCUSDT',
  bestBid: '100.01',
  bestAsk: '100.02',
  observedAtUtc: '2026-01-01T00:00:00.000Z',
  receivedAtUtc: '2026-01-01T00:00:00.000Z',
  source: 'test fixture',
  kind: 'TEST_FIXTURE',
};

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

describe('Binance public book ticker adapter', () => {
  it('requests the market-data-only endpoint and returns validated decimal strings', async () => {
    const fetch = vi.fn(async () =>
      response({
        symbol: 'BTCUSDT',
        bidPrice: '63123.4500',
        askPrice: '63124.00',
      }),
    );
    const port = createBinanceSpotMarketDataPort({
      fetch,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const result = await port.currentQuote('BTCUSDT');
    expect(fetch).toHaveBeenCalledWith(
      'https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=BTCUSDT',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        bestBid: '63123.4500',
        bestAsk: '63124.00',
        kind: 'LIVE_PUBLIC',
        observedAtUtc: '2026-01-01T00:00:00.000Z',
        receivedAtUtc: '2026-01-01T00:00:00.000Z',
      },
    });
  });

  it.each([
    { symbol: 'ETHUSDT', bidPrice: '1', askPrice: '2' },
    { symbol: 'BTCUSDT', bidPrice: '0', askPrice: '2' },
    { symbol: 'BTCUSDT', bidPrice: '1e2', askPrice: '2' },
    { symbol: 'BTCUSDT', bidPrice: '1', askPrice: 'NaN' },
  ])('rejects untrusted payload %#', async (payload) => {
    const port = createBinanceSpotMarketDataPort({
      fetch: async () => response(payload),
    });
    await expect(port.currentQuote('BTCUSDT')).resolves.toMatchObject({
      ok: false,
      code: 'REJECTED',
      retrySafe: false,
    });
  });

  it('returns structured rate limit and timeout errors', async () => {
    const limited = createBinanceSpotMarketDataPort({
      fetch: async () => response({}, 429),
    });
    await expect(limited.currentQuote('BTCUSDT')).resolves.toMatchObject({
      ok: false,
      code: 'RATE_LIMIT',
    });

    const timeout = createBinanceSpotMarketDataPort({
      timeoutMs: 1,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    });
    await expect(timeout.currentQuote('BTCUSDT')).resolves.toMatchObject({
      ok: false,
      code: 'TIMEOUT',
    });
  });
});

describe('quote freshness', () => {
  it('measures age from receive time and marks boundary deterministically', () => {
    const now = new Date('2026-01-01T00:00:02.000Z');
    expect(quoteAgeMs(quote, now)).toBe(2_000);
    expect(isQuoteFresh(quote, now, 2_000)).toBe(true);
    expect(classifyQuoteFreshness(quote, now, 1_999)).toBe('STALE');
    expect(
      isQuoteFresh(quote, new Date('2025-12-31T23:59:59.000Z'), 2_000),
    ).toBe(false);
  });
});
