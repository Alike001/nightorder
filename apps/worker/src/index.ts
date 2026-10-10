import {
  classifyQuoteFreshness,
  createBinanceSpotMarketDataPort,
  type Clock,
  type MarketDataPort,
} from '@nightorder/quotes';

export async function pollOnce(
  port: MarketDataPort,
  log: (message: string) => void = console.info,
  now: Clock = () => new Date(),
  maxAgeMs = 5_000,
): Promise<void> {
  const result = await port.currentQuote('BTCUSDT');
  if (!result.ok) {
    log(
      `market-data error code=${result.code} retrySafe=${result.retrySafe} message=${result.message}`,
    );
    return;
  }
  const state = classifyQuoteFreshness(result.data, now(), maxAgeMs);
  log(
    `market-data ${state.toLowerCase()} symbol=${result.data.symbol} bid=${result.data.bestBid} ask=${result.data.bestAsk} ageMs=${Math.max(0, now().getTime() - Date.parse(result.data.receivedAtUtc))}`,
  );
}

export async function runPollingLoop(
  port: MarketDataPort,
  options: {
    intervalMs?: number;
    maxAgeMs?: number;
    log?: (message: string) => void;
    now?: Clock;
    sleep?: (ms: number) => Promise<void>;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const intervalMs = options.intervalMs ?? 1_000;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  while (!options.signal?.aborted) {
    await pollOnce(port, options.log, options.now, options.maxAgeMs);
    if (!options.signal?.aborted) await sleep(intervalMs);
  }
}

export async function main(): Promise<void> {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  // This worker only observes public prices. It has no execution adapter and never submits orders.
  await runPollingLoop(createBinanceSpotMarketDataPort(), {
    signal: controller.signal,
  });
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  void main();
}
