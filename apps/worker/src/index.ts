import {
  classifyQuoteFreshness,
  createBinanceSpotMarketDataPort,
  type Clock,
  type MarketDataPort,
} from '@nightorder/quotes';
import { SqliteArmedPlanStore } from './armed-plans.js';

export async function pollOnce(
  port: MarketDataPort,
  log: (message: string) => void = console.info,
  now: Clock = () => new Date(),
  maxAgeMs = 5_000,
  armedPlans?: SqliteArmedPlanStore,
): Promise<void> {
  const expiredPlanIds = armedPlans?.expireDuePlans(now()) ?? [];
  if (expiredPlanIds.length > 0) {
    log(`watcher plans expired ids=${expiredPlanIds.join(',')}`);
  }
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
  if (armedPlans) {
    const evaluation = armedPlans.evaluateQuote(result.data, maxAgeMs, now());
    if (evaluation.expiredPlanIds.length > 0) {
      log(`watcher plans expired ids=${evaluation.expiredPlanIds.join(',')}`);
    }
    if (evaluation.triggeredPlanIds.length > 0) {
      log(
        `watcher plans triggered ids=${evaluation.triggeredPlanIds.join(',')} execution=not-configured`,
      );
    }
  }
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
    armedPlans?: SqliteArmedPlanStore;
  } = {},
): Promise<void> {
  const intervalMs = options.intervalMs ?? 1_000;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  while (!options.signal?.aborted) {
    await pollOnce(
      port,
      options.log,
      options.now,
      options.maxAgeMs,
      options.armedPlans,
    );
    if (!options.signal?.aborted) await sleep(intervalMs);
  }
}

export async function main(): Promise<void> {
  const controller = new AbortController();
  const armedPlans = new SqliteArmedPlanStore(
    process.env.NIGHTORDER_WORKER_DB ?? 'nightorder-worker.sqlite',
  );
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  // This worker only observes public prices. It has no execution adapter and never submits orders.
  try {
    await runPollingLoop(createBinanceSpotMarketDataPort(), {
      signal: controller.signal,
      armedPlans,
    });
  } finally {
    armedPlans.close();
  }
}

if (
  process.env.NIGHTORDER_START !== '1' &&
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  void main();
}

// Telegram is a separately selected worker mode.
if (process.env.NIGHTORDER_START === '1') {
  void import('./live-telegram.js')
    .then(({ startNightOrderTelegram }) => startNightOrderTelegram())
    .catch(() => {
      console.error(
        'NIGHTORDER_WORKER_START_FAILED: check environment and local configuration',
      );
      process.exitCode = 1;
    });
}
