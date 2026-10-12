/** The frozen shared MarketQuote draft, duplicated here to keep this adapter independent of domain. */
export type MarketQuote = {
  symbol: 'BTCUSDT';
  bestBid: string;
  bestAsk: string;
  /** Sampled at receive time because Binance bookTicker has no exchange event timestamp. */
  observedAtUtc: string;
  receivedAtUtc: string;
  source: string;
  kind: 'LIVE_PUBLIC' | 'TEST_FIXTURE';
};

export type ToolResult<T> =
  | { ok: true; data: T; evidenceId: string }
  | {
      ok: false;
      code:
        | 'STALE_QUOTE'
        | 'EXPIRED'
        | 'UNAUTHORIZED'
        | 'INSUFFICIENT_BALANCE'
        | 'REJECTED'
        | 'TIMEOUT'
        | 'RATE_LIMIT'
        | 'NETWORK'
        | 'NOT_FOUND'
        | 'AMBIGUOUS';
      message: string;
      retrySafe: boolean;
      evidenceId: string;
    };

export interface MarketDataPort {
  currentQuote(symbol: 'BTCUSDT'): Promise<ToolResult<MarketQuote>>;
}

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;
export type Clock = () => Date;

const SOURCE = 'Binance Spot public market data (data-api.binance.vision)';
const ENDPOINT =
  'https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=BTCUSDT';
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

function error<T>(
  code: Extract<ToolResult<T>, { ok: false }>['code'],
  message: string,
  retrySafe: boolean,
  evidenceId: string,
): ToolResult<T> {
  return { ok: false, code, message, retrySafe, evidenceId };
}

function positiveDecimal(value: unknown): value is string {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return false;
  return /[1-9]/.test(value);
}

/** Public, unauthenticated Spot book ticker adapter. Quote age starts when this worker receives it. */
export function createBinanceSpotMarketDataPort(
  options: {
    fetch?: FetchLike;
    now?: Clock;
    timeoutMs?: number;
  } = {},
): MarketDataPort {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 5_000;

  return {
    async currentQuote(symbol) {
      const evidenceId = `binance-book-ticker:${symbol}`;
      if (symbol !== 'BTCUSDT')
        return error(
          'REJECTED',
          'Unsupported market symbol.',
          false,
          evidenceId,
        );
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetcher(ENDPOINT, {
          method: 'GET',
          signal: controller.signal,
        });
        if (!response.ok) {
          if (response.status === 429)
            return error(
              'RATE_LIMIT',
              'Binance rate limited the quote request.',
              true,
              evidenceId,
            );
          return error(
            'NETWORK',
            `Binance returned HTTP ${response.status}.`,
            true,
            evidenceId,
          );
        }
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          return error(
            'REJECTED',
            'Binance returned invalid JSON.',
            false,
            evidenceId,
          );
        }
        if (typeof payload !== 'object' || payload === null) {
          return error(
            'REJECTED',
            'Binance returned an invalid book ticker payload.',
            false,
            evidenceId,
          );
        }
        const record = payload as Record<string, unknown>;
        if (
          record.symbol !== 'BTCUSDT' ||
          !positiveDecimal(record.bidPrice) ||
          !positiveDecimal(record.askPrice)
        ) {
          return error(
            'REJECTED',
            'Binance book ticker failed symbol or positive decimal validation.',
            false,
            evidenceId,
          );
        }
        const receivedAtUtc = now().toISOString();
        return {
          ok: true,
          data: {
            symbol: 'BTCUSDT',
            bestBid: record.bidPrice,
            bestAsk: record.askPrice,
            observedAtUtc: receivedAtUtc,
            receivedAtUtc,
            source: SOURCE,
            kind: 'LIVE_PUBLIC',
          },
          evidenceId,
        };
      } catch (cause) {
        if (controller.signal.aborted)
          return error(
            'TIMEOUT',
            'Binance quote request timed out.',
            true,
            evidenceId,
          );
        return error(
          'NETWORK',
          cause instanceof Error
            ? cause.message
            : 'Binance quote request failed.',
          true,
          evidenceId,
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export function quoteAgeMs(quote: MarketQuote, now: Date): number {
  return Math.max(0, now.getTime() - Date.parse(quote.receivedAtUtc));
}

export function isQuoteFresh(
  quote: MarketQuote,
  now: Date,
  maxAgeMs: number,
): boolean {
  const received = Date.parse(quote.receivedAtUtc);
  return (
    Number.isFinite(received) &&
    Number.isFinite(now.getTime()) &&
    now.getTime() >= received &&
    now.getTime() - received <= maxAgeMs
  );
}

export function classifyQuoteFreshness(
  quote: MarketQuote,
  now: Date,
  maxAgeMs: number,
): 'LIVE' | 'STALE' {
  return isQuoteFresh(quote, now, maxAgeMs) ? 'LIVE' : 'STALE';
}
