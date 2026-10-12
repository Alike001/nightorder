/** PAPER execution worker. Telegram and this worker share one durable plan store. */
import { mkdirSync } from 'node:fs';
import { hasValidPlanHash } from '@nightorder/domain';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GeminiDiagnosticModel } from './gemini-diagnostic.js';
import { SqliteArmedPlanStore } from './armed-plans.js';
import { createBinanceSpotMarketDataPort } from '@nightorder/quotes';
import { SqlitePaperExecutionAdapter } from '@nightorder/execution';
import {
  IntegratedTradingRuntime,
  SqliteTradingPlanRepository,
  type PersistentWatcher,
} from '@nightorder/runtime';
import {
  initializeNeatlogsFromEnvironment,
  generateRunId,
  pseudonymizePlanId,
} from '@nightorder/tracing';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function validatePaperWorkerEnvironment(env: NodeJS.ProcessEnv): {
  ownerId: string;
  databasePath: string;
  watcherPath: string;
  paperPath: string;
  intervalMs: number;
  geminiKey: string;
  geminiModel: string;
  initialUsdt: string;
  initialBtc: string;
} {
  if (env.NIGHTORDER_ENABLE_PAPER_EXECUTION !== 'true') {
    throw new Error('PAPER execution must be explicitly armed');
  }
  const owners = required(env, 'TELEGRAM_ALLOWED_USER_IDS')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (owners.length !== 1 || !/^\d+$/.test(owners[0] ?? '')) {
    throw new Error('PAPER MVP requires exactly one numeric Telegram owner ID');
  }
  const intervalMs = Number(env.NIGHTORDER_PAPER_POLL_MS ?? '5000');
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 2000 ||
    intervalMs > 60000
  ) {
    throw new Error('PAPER polling interval must be between 2000 and 60000 ms');
  }
  const initialUsdt = env.NIGHTORDER_PAPER_INITIAL_USDT ?? '1000';
  const initialBtc = env.NIGHTORDER_PAPER_INITIAL_BTC ?? '0.25';
  if (
    ![initialUsdt, initialBtc].every((s) => /^(0|[1-9]\d*)(\.\d+)?$/.test(s))
  ) {
    throw new Error(
      'Virtual starting balances must be nonnegative decimal strings',
    );
  }
  return {
    ownerId: owners[0]!,
    databasePath: resolve(
      env.NIGHTORDER_DATABASE_PATH ?? './data/nightorder.sqlite',
    ),
    watcherPath: resolve(
      env.NIGHTORDER_WATCHER_DATABASE_PATH ??
        './data/nightorder-watcher.sqlite',
    ),
    paperPath: resolve(
      env.NIGHTORDER_PAPER_DATABASE_PATH ?? './data/nightorder-paper.sqlite',
    ),
    intervalMs,
    geminiKey: required(env, 'GEMINI_API_KEY'),
    geminiModel: required(env, 'GEMINI_MODEL'),
    initialUsdt,
    initialBtc,
  };
}

export async function startNightOrderPaper(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  required(env, 'NEATLOGS_API_KEY');
  const config = validatePaperWorkerEnvironment(env);
  for (const path of [
    config.databasePath,
    config.watcherPath,
    config.paperPath,
  ]) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const trace = await initializeNeatlogsFromEnvironment(env);
  if (trace.state !== 'READY')
    throw new Error('Neatlogs initialization is required');
  const repository = new SqliteTradingPlanRepository({
    databasePath: config.databasePath,
  });
  const watcher = new SqliteArmedPlanStore(config.watcherPath);
  // Convert synchronous persisted evidence to the executor's async reader.
  const approvedPlanReader = {
    loadPlan: (planId: string) => repository.loadPlan(planId),
    loadPlanEvidence: async (planId: string) =>
      repository.loadPlanEvidence(planId),
    loadAuthorizationEvidence: async (planId: string) =>
      repository.loadAuthorizationEvidence(planId),
  };

  // Enforce the watcher contract at the runtime boundary.
  const guardedWatcher: PersistentWatcher = {
    saveArmedPlan: (plan) => {
      if (
        plan.state !== 'ARMED' ||
        plan.mode !== 'PAPER' ||
        !plan.approvedAtUtc ||
        !hasValidPlanHash(plan)
      ) {
        throw new Error('Watcher requires a valid approved PAPER plan');
      }
      watcher.saveArmedPlan({
        ...plan,
        state: 'ARMED',
        approvedAtUtc: plan.approvedAtUtc,
      });
    },
    listArmedPlans: () => watcher.listArmedPlans(),
    evaluateQuote: (quote, maxAgeMs, now) =>
      watcher.evaluateQuote(quote, maxAgeMs, now),
    getState: (planId) => watcher.getState(planId),
    close: () => watcher.close(),
  };

  const execution = new SqlitePaperExecutionAdapter(approvedPlanReader, {
    databasePath: config.paperPath,
    initialBalances: { USDT: config.initialUsdt, BTC: config.initialBtc },
  });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const market = createBinanceSpotMarketDataPort();
  let runId = generateRunId();
  const runtime = new IntegratedTradingRuntime({
    ownerId: config.ownerId,
    plans: repository,
    watcher: guardedWatcher,
    execution,
    market,
    model: new GeminiDiagnosticModel(config.geminiKey, config.geminiModel),
    traces: {
      emit: async (event) => {
        const planId = event.attributes.planId;
        await trace.sink.record({
          name: event.name,
          kind: event.name.includes('.tool.') ? 'TOOL' : 'AGENT',
          runId,
          atUtc: new Date().toISOString(),
          ...(typeof planId === 'string'
            ? { pseudonymousPlanId: pseudonymizePlanId(planId) }
            : {}),
          attributes: Object.fromEntries(
            Object.entries(event.attributes).filter(
              ([key]) => key !== 'planId' && key !== 'operationId',
            ),
          ),
        });
      },
    },
  });
  console.info('NightOrder integrated PAPER runtime started; no live orders.');
  try {
    while (!controller.signal.aborted) {
      runId = generateRunId();
      try {
        const result = await trace.sink.runSpan(
          {
            name: 'paper.runtime.poll',
            kind: 'WORKFLOW',
            runId,
            atUtc: new Date().toISOString(),
            attributes: { mode: 'PAPER' },
          },
          async (scope) => {
            const polled = await runtime.pollOnce();
            scope.setAttribute('quote_kind', polled.quoteKind);
            scope.setAttribute('plan_count', polled.plans.length);
            scope.setAttribute(
              'escalation_count',
              polled.plans.filter((p) => p.outcome === 'ESCALATED').length,
            );
            return polled;
          },
        );
        if (result.plans.length > 0) {
          console.info(
            'PAPER_RUNTIME_RESULTS',
            JSON.stringify({
              quoteKind: result.quoteKind,
              outcomes: result.plans.map((p) => p.outcome),
            }),
          );
        }
      } catch (error) {
        // Never retry submission here. The next runtime poll reconciles persisted
        // SUBMITTING/UNCERTAIN attempts before any new execution claim.
        console.error(
          'PAPER_RUNTIME_POLL_FAILED',
          error instanceof Error ? error.name : 'UNKNOWN',
        );
      }
      if (!controller.signal.aborted) {
        await new Promise<void>((done) => setTimeout(done, config.intervalMs));
      }
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    execution.close();
    watcher.close();
    repository.close();
    await trace.shutdown();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void startNightOrderPaper().catch((error) => {
    console.error(
      'PAPER_RUNTIME_START_FAILED',
      error instanceof Error ? error.message : 'UNKNOWN',
    );
    process.exitCode = 1;
  });
}
