import { DatabaseSync } from 'node:sqlite';
import { isQuoteFresh, type MarketQuote } from '@nightorder/quotes';

/** Local structural projection; shared Zod contracts remain owned by #2. */
export interface ArmedTradePlan {
  id: string;
  ownerId: string;
  symbol: 'BTCUSDT';
  side: 'BUY' | 'SELL';
  quoteBudgetUsdt?: string;
  baseQuantityBtc?: string;
  triggerPrice: string;
  triggerOperator: 'ASK_LTE' | 'BID_GTE';
  limitPrice: string;
  expiresAtUtc: string;
  timezone: string;
  mode: 'PAPER' | 'TESTNET';
  planHash: string;
  approvedAtUtc: string;
  state: 'ARMED';
  revision: number;
}

export interface QuoteEvaluation {
  fresh: boolean;
  expiredPlanIds: string[];
  triggeredPlanIds: string[];
}

const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

function parseDecimal(value: string): { value: bigint; scale: number } {
  if (!decimalPattern.test(value)) throw new Error('Invalid decimal value.');
  const [whole = '', fraction = ''] = value.split('.');
  return { value: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function compareDecimal(left: string, right: string): number {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  const scale = Math.max(a.scale, b.scale);
  const av = a.value * 10n ** BigInt(scale - a.scale);
  const bv = b.value * 10n ** BigInt(scale - b.scale);
  return av === bv ? 0 : av < bv ? -1 : 1;
}

function isUtcIso(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function validatePlan(plan: ArmedTradePlan): void {
  if (
    !plan.id ||
    !plan.ownerId ||
    plan.symbol !== 'BTCUSDT' ||
    !plan.planHash ||
    plan.state !== 'ARMED' ||
    !Number.isSafeInteger(plan.revision) ||
    plan.revision < 0 ||
    !isUtcIso(plan.expiresAtUtc) ||
    !isUtcIso(plan.approvedAtUtc)
  ) {
    throw new Error(
      'Plan is missing valid identity, approval, state, or UTC timestamps.',
    );
  }
  if (
    (plan.side === 'BUY' && plan.triggerOperator !== 'ASK_LTE') ||
    (plan.side === 'SELL' && plan.triggerOperator !== 'BID_GTE')
  ) {
    throw new Error('Plan trigger direction does not match its side.');
  }
  for (const value of [plan.triggerPrice, plan.limitPrice]) {
    if (parseDecimal(value).value <= 0n)
      throw new Error('Plan prices must be positive.');
  }
}

/** Durable worker-side store for approved plans. It never creates or submits orders. */
export class SqliteArmedPlanStore {
  private readonly database: DatabaseSync;

  constructor(
    databasePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS watcher_plans (
        plan_id TEXT PRIMARY KEY,
        plan_hash TEXT NOT NULL,
        expires_at_utc TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('ARMED', 'TRIGGERED', 'EXPIRED')),
        plan_json TEXT NOT NULL
      ) STRICT;
    `);
  }

  /** Insert once; repeating the exact approved plan is idempotent. */
  saveArmedPlan(plan: ArmedTradePlan): void {
    validatePlan(plan);
    const stored = this.database
      .prepare(
        'SELECT plan_hash, plan_json FROM watcher_plans WHERE plan_id = ?',
      )
      .get(plan.id) as { plan_hash: string; plan_json: string } | undefined;
    const planJson = JSON.stringify(plan);
    if (stored) {
      if (stored.plan_hash === plan.planHash && stored.plan_json === planJson)
        return;
      throw new Error(
        'An armed plan with this id already exists with different contents.',
      );
    }
    this.database
      .prepare(
        `INSERT INTO watcher_plans (plan_id, plan_hash, expires_at_utc, state, plan_json)
         VALUES (?, ?, ?, 'ARMED', ?)`,
      )
      .run(plan.id, plan.planHash, plan.expiresAtUtc, planJson);
  }

  listArmedPlans(): ArmedTradePlan[] {
    this.expirePlans();
    const rows = this.database
      .prepare(
        "SELECT plan_json FROM watcher_plans WHERE state = 'ARMED' ORDER BY plan_id",
      )
      .all() as Array<{ plan_json: string }>;
    return rows.map((row) => JSON.parse(row.plan_json) as ArmedTradePlan);
  }

  /** Expiry and trigger transitions are durable, guarded state changes. */
  evaluateQuote(
    quote: MarketQuote,
    maxAgeMs: number,
    now = this.now(),
  ): QuoteEvaluation {
    const expiredPlanIds = this.expirePlans(now);
    if (quote.symbol !== 'BTCUSDT') {
      return { fresh: false, expiredPlanIds, triggeredPlanIds: [] };
    }
    if (!isQuoteFresh(quote, now, maxAgeMs)) {
      return { fresh: false, expiredPlanIds, triggeredPlanIds: [] };
    }

    const triggeredPlanIds: string[] = [];
    for (const plan of this.listArmedPlans()) {
      const observedPrice = plan.side === 'BUY' ? quote.bestAsk : quote.bestBid;
      const crossed =
        plan.side === 'BUY'
          ? compareDecimal(observedPrice, plan.triggerPrice) <= 0
          : compareDecimal(observedPrice, plan.triggerPrice) >= 0;
      if (!crossed) continue;
      const result = this.database
        .prepare(
          "UPDATE watcher_plans SET state = 'TRIGGERED' WHERE plan_id = ? AND state = 'ARMED'",
        )
        .run(plan.id);
      if (Number(result.changes) === 1) triggeredPlanIds.push(plan.id);
    }
    return { fresh: true, expiredPlanIds, triggeredPlanIds };
  }

  getState(planId: string): 'ARMED' | 'TRIGGERED' | 'EXPIRED' | null {
    const row = this.database
      .prepare('SELECT state FROM watcher_plans WHERE plan_id = ?')
      .get(planId) as { state: 'ARMED' | 'TRIGGERED' | 'EXPIRED' } | undefined;
    return row?.state ?? null;
  }

  close(): void {
    this.database.close();
  }

  private expirePlans(now = this.now()): string[] {
    const timestamp = now.toISOString();
    const rows = this.database
      .prepare(
        "SELECT plan_id FROM watcher_plans WHERE state = 'ARMED' AND expires_at_utc <= ?",
      )
      .all(timestamp) as Array<{ plan_id: string }>;
    this.database
      .prepare(
        "UPDATE watcher_plans SET state = 'EXPIRED' WHERE state = 'ARMED' AND expires_at_utc <= ?",
      )
      .run(timestamp);
    return rows.map((row) => row.plan_id);
  }
}
