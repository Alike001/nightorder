/** NightOrder Telegram runtime. Never sends a trade directly from Telegram. */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  OpenAIInstructionInterpreter,
  TelegramInstructionWorkflow,
  telegramAllowlistFromEnv,
} from '@nightorder/telegram';
import { initializeNeatlogsFromEnvironment } from '@nightorder/tracing';
import { SqliteTradingPlanRepository } from '@nightorder/runtime';
import {
  SqliteTelegramDeliveryStore,
  TelegramBotApi,
  TelegramDeliveryWorker,
} from './telegram-transport.js';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/** Avoid silently ignoring plans in the previous Telegram-only tables. */
function ensureNoLegacyTelegramPlans(databasePath: string): void {
  if (!existsSync(databasePath)) return;
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'telegram_plans'",
      )
      .get();
    if (!table) return;
    const row = db
      .prepare('SELECT COUNT(*) AS count FROM telegram_plans')
      .get() as { count: number } | undefined;
    if (Number(row?.count ?? 0) !== 0) {
      throw new Error(
        'Existing Telegram plans need explicit migration before switching to the shared plan repository. Existing records were not modified.',
      );
    }
  } finally {
    db.close();
  }
}

export async function startNightOrderTelegram(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const telegramToken = required(env, 'TELEGRAM_BOT_TOKEN');
  const aiProvider = (env.NIGHTORDER_AI_PROVIDER ?? 'OPENAI')
    .trim()
    .toUpperCase();
  if (aiProvider !== 'OPENAI' && aiProvider !== 'GEMINI') {
    throw new Error('NIGHTORDER_AI_PROVIDER must be OPENAI or GEMINI');
  }
  const aiKey = required(
    env,
    aiProvider === 'GEMINI' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY',
  );
  const aiModel = required(
    env,
    aiProvider === 'GEMINI' ? 'GEMINI_MODEL' : 'OPENAI_MODEL',
  );
  required(env, 'NEATLOGS_API_KEY');
  const allowedUserIds = telegramAllowlistFromEnv(
    required(env, 'TELEGRAM_ALLOWED_USER_IDS'),
  );
  if (!allowedUserIds.length)
    throw new Error('Telegram allowlist must not be empty');
  const databasePath = resolve(
    env.NIGHTORDER_DATABASE_PATH ?? './data/nightorder.sqlite',
  );
  const trace = await initializeNeatlogsFromEnvironment(env);
  if (trace.state !== 'READY') {
    throw new Error('Neatlogs initialization failed; confirm NEATLOGS_API_KEY');
  }
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  ensureNoLegacyTelegramPlans(databasePath);
  const repository = new SqliteTradingPlanRepository({ databasePath });
  const deliveries = new SqliteTelegramDeliveryStore(databasePath);
  const workflow = new TelegramInstructionWorkflow({
    allowedUserIds,
    repository,
    interpreter: new OpenAIInstructionInterpreter({
      apiKey: aiKey,
      model: aiModel,
      provider: aiProvider,
    }),
    trace: trace.sink,
  });
  const worker = new TelegramDeliveryWorker(
    new TelegramBotApi(telegramToken),
    deliveries,
    (message) => workflow.handle(message),
  );
  const aborter = new AbortController();
  const stop = () => aborter.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    console.info('NightOrder Telegram runtime started (PAPER only).');
    await worker.runUntilAborted(aborter.signal, (code) => {
      console.error(code); // Generic error code; never print bot token/URL.
    });
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    deliveries.close();
    repository.close();
    await trace.shutdown();
  }
}
