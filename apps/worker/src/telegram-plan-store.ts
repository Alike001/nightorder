/**
 * Durable, serialised PAPER-plan repository for Telegram and future execution.
 * All updates are SQLite transactions and go through domain state validation.
 * The application deliberately does not submit orders from Telegram.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  compareUtcTimestamps,
  orderAttemptSchema,
  tradePlanSchema,
  utcTimestampSchema,
  validatePlanTransition,
  type OrderAttempt,
  type ToolErrorCode,
  type ToolResult,
  type TradePlan,
} from '@nightorder/domain';
import type { TelegramPlanRepository } from '@nightorder/telegram';

type StoredPlan = { readonly plan_json: string; readonly revision: number };
type StoredAttempt = { readonly attempt_json: string };

class StoreFailure extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class SqliteTelegramPlanRepository implements TelegramPlanRepository {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    if (!databasePath.trim())
      throw new Error('NightOrder plan database path required');
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    try {
      chmodSync(databasePath, 0o600);
    } catch {
      // Some development filesystems do not support mode changes.
    }
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS telegram_plans (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        state TEXT NOT NULL,
        plan_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_telegram_plans_owner
      ON telegram_plans(owner_id, id);
      CREATE TABLE IF NOT EXISTS telegram_plan_attempts (
        plan_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        attempt_json TEXT NOT NULL,
        FOREIGN KEY(plan_id) REFERENCES telegram_plans(id)
      );
      CREATE TABLE IF NOT EXISTS telegram_plan_observations (
        evidence_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        at_utc TEXT NOT NULL,
        event_json TEXT NOT NULL,
        FOREIGN KEY(plan_id) REFERENCES telegram_plans(id)
      );
    `);
  }

  private atomic<T>(callback: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private find(planId: string): TradePlan | null {
    const row = this.db
      .prepare('SELECT plan_json, revision FROM telegram_plans WHERE id = ?')
      .get(planId) as StoredPlan | undefined;
    return row ? tradePlanSchema.parse(JSON.parse(row.plan_json)) : null;
  }

  private write(next: TradePlan, expectedRevision: number): void {
    const result = this.db
      .prepare(
        `UPDATE telegram_plans
        SET plan_json=?, revision=?, state=?
        WHERE id=? AND revision=?`,
      )
      .run(
        JSON.stringify(next),
        next.revision,
        next.state,
        next.id,
        expectedRevision,
      );
    if (result.changes !== 1) {
      throw new StoreFailure('AMBIGUOUS', 'Plan was modified concurrently');
    }
  }

  private transition(
    current: TradePlan,
    next: TradePlan,
    expectedRevision: number,
    nowUtc: string,
  ): TradePlan {
    if (current.revision !== expectedRevision) {
      throw new StoreFailure(
        'AMBIGUOUS',
        'Plan revision changed; reload first',
      );
    }
    const validated = validatePlanTransition(current, next, nowUtc);
    this.write(validated, expectedRevision);
    return validated;
  }

  private ok<T>(data: T): ToolResult<T> {
    return { ok: true, data: structuredClone(data), evidenceId: randomUUID() };
  }

  private failure<T>(error: unknown): ToolResult<T> {
    return {
      ok: false,
      code: error instanceof StoreFailure ? error.code : 'REJECTED',
      message:
        error instanceof StoreFailure
          ? error.message
          : 'Request rejected by plan state validation',
      retrySafe: false,
      evidenceId: randomUUID(),
    };
  }

  private result<T>(operation: () => T): ToolResult<T> {
    try {
      return this.ok(this.atomic(operation));
    } catch (error) {
      return this.failure(error);
    }
  }

  async createDraft(value: TradePlan): Promise<void> {
    const plan = tradePlanSchema.parse(value);
    if (plan.state !== 'DRAFT' || plan.revision !== 0) {
      throw new Error('New plan must begin at revision-zero DRAFT');
    }
    this.atomic(() => {
      this.db
        .prepare(
          `INSERT INTO telegram_plans
        (id,owner_id,revision,state,plan_json) VALUES (?,?,?,?,?)`,
        )
        .run(
          plan.id,
          plan.ownerId,
          plan.revision,
          plan.state,
          JSON.stringify(plan),
        );
    });
  }

  async loadPlan(planId: string): Promise<TradePlan | null> {
    return this.find(planId);
  }

  async listPlansByOwner(ownerId: string): Promise<readonly TradePlan[]> {
    const rows = this.db
      .prepare(
        'SELECT plan_json FROM telegram_plans WHERE owner_id = ? ORDER BY id',
      )
      .all(ownerId) as { plan_json: string }[];
    return rows.map((row) => tradePlanSchema.parse(JSON.parse(row.plan_json)));
  }

  async saveTransition(
    nextValue: TradePlan,
    expectedRevision: number,
    transitionedAtUtcInput: string,
  ): Promise<ToolResult<TradePlan>> {
    return this.result(() => {
      const nowUtc = utcTimestampSchema.parse(transitionedAtUtcInput);
      const next = tradePlanSchema.parse(nextValue);
      const current = this.find(next.id);
      if (!current) throw new StoreFailure('NOT_FOUND', 'Plan not found');
      return this.transition(current, next, expectedRevision, nowUtc);
    });
  }

  async approveExactAtRevision(
    planId: string,
    ownerId: string,
    expectedHash: string,
    expectedRevision: number,
    approvedAtUtcInput: string,
  ): Promise<ToolResult<TradePlan>> {
    return this.result(() => {
      const atUtc = utcTimestampSchema.parse(approvedAtUtcInput);
      const current = this.find(planId);
      if (!current) throw new StoreFailure('NOT_FOUND', 'Plan not found');
      if (current.ownerId !== ownerId)
        throw new StoreFailure('UNAUTHORIZED', 'Wrong plan owner');
      if (current.revision !== expectedRevision)
        throw new StoreFailure('AMBIGUOUS', 'Stale revision');
      if (current.planHash !== expectedHash)
        throw new StoreFailure('UNAUTHORIZED', 'Approval digest mismatch');
      if (current.state !== 'AWAITING_CONFIRMATION')
        throw new StoreFailure('REJECTED', 'Plan not awaiting approval');
      if (compareUtcTimestamps(atUtc, current.expiresAtUtc) >= 0) {
        throw new StoreFailure('EXPIRED', 'Plan expired before approval');
      }
      return this.transition(
        current,
        {
          ...current,
          approvedAtUtc: atUtc,
          state: 'ARMED',
          revision: current.revision + 1,
        },
        expectedRevision,
        atUtc,
      );
    });
  }

  async approveExact(
    planId: string,
    ownerId: string,
    hash: string,
  ): Promise<ToolResult<TradePlan>> {
    const current = this.find(planId);
    if (!current)
      return this.failure(new StoreFailure('NOT_FOUND', 'Plan not found'));
    return this.approveExactAtRevision(
      planId,
      ownerId,
      hash,
      current.revision,
      new Date().toISOString(),
    );
  }

  async cancelOwnedAtRevision(
    planId: string,
    ownerId: string,
    expectedRevision: number,
    requestedAtUtcInput: string,
  ): Promise<ToolResult<TradePlan>> {
    return this.result(() => {
      const nowUtc = utcTimestampSchema.parse(requestedAtUtcInput);
      const current = this.find(planId);
      if (!current) throw new StoreFailure('NOT_FOUND', 'Plan not found');
      if (current.ownerId !== ownerId)
        throw new StoreFailure('UNAUTHORIZED', 'Wrong plan owner');
      if (current.revision !== expectedRevision)
        throw new StoreFailure('AMBIGUOUS', 'Stale revision');
      if (current.state === 'CANCELLED' || current.state === 'CANCEL_REQUESTED')
        return current;
      if (current.state === 'ARMED' || current.state === 'TRIGGERED') {
        const target =
          compareUtcTimestamps(nowUtc, current.expiresAtUtc) >= 0
            ? 'EXPIRED'
            : 'CANCELLED';
        return this.transition(
          current,
          {
            ...current,
            state: target,
            revision: current.revision + 1,
          },
          expectedRevision,
          nowUtc,
        );
      }
      // Do not create a CANCEL_REQUESTED state unless an executor can actually
      // receive the request and independently confirm order state.
      if (
        current.state === 'OPEN' ||
        current.state === 'PARTIALLY_FILLED' ||
        current.state === 'UNCERTAIN'
      ) {
        throw new StoreFailure(
          'AMBIGUOUS',
          'Order cancellation requires executor integration and verified readback',
        );
      }
      throw new StoreFailure('REJECTED', `Cannot cancel from ${current.state}`);
    });
  }

  async claimForExecution(
    planId: string,
    expectedRevision: number,
    operationId: string,
  ): Promise<ToolResult<OrderAttempt>> {
    return this.result(() => {
      const nowUtc = new Date().toISOString();
      const current = this.find(planId);
      if (!current) throw new StoreFailure('NOT_FOUND', 'Plan not found');
      if (current.revision !== expectedRevision)
        throw new StoreFailure('AMBIGUOUS', 'Stale revision');
      if (current.state !== 'TRIGGERED')
        throw new StoreFailure('REJECTED', 'Plan must be TRIGGERED');
      if (compareUtcTimestamps(nowUtc, current.expiresAtUtc) >= 0) {
        throw new StoreFailure('EXPIRED', 'Plan has expired');
      }
      const existing = this.db
        .prepare(
          'SELECT attempt_json FROM telegram_plan_attempts WHERE plan_id = ?',
        )
        .get(planId) as StoredAttempt | undefined;
      if (existing)
        throw new StoreFailure(
          'AMBIGUOUS',
          'Existing attempt requires reconciliation',
        );
      const attempt = orderAttemptSchema.parse({
        id: randomUUID(),
        planId,
        operationId,
        clientOrderId: `nightorder-${planId}`,
        requestDigest: current.planHash,
        state: 'PREPARED',
        evidenceSource: 'ORIGINAL_PAPER',
        createdAtUtc: nowUtc,
      });
      this.transition(
        current,
        {
          ...current,
          state: 'SUBMITTING',
          revision: current.revision + 1,
        },
        expectedRevision,
        nowUtc,
      );
      this.db
        .prepare(
          `INSERT INTO telegram_plan_attempts
        (plan_id, operation_id, attempt_json) VALUES (?,?,?)`,
        )
        .run(planId, operationId, JSON.stringify(attempt));
      return attempt;
    });
  }

  async loadAttempt(planId: string): Promise<OrderAttempt | null> {
    const row = this.db
      .prepare(
        'SELECT attempt_json FROM telegram_plan_attempts WHERE plan_id = ?',
      )
      .get(planId) as StoredAttempt | undefined;
    return row ? orderAttemptSchema.parse(JSON.parse(row.attempt_json)) : null;
  }

  async recordObservation(
    planId: string,
    event: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    this.atomic(() => {
      if (!this.find(planId))
        throw new StoreFailure('NOT_FOUND', 'Plan not found');
      this.db
        .prepare(
          `INSERT INTO telegram_plan_observations
        (evidence_id, plan_id, at_utc, event_json) VALUES (?,?,?,?)`,
        )
        .run(
          randomUUID(),
          planId,
          new Date().toISOString(),
          JSON.stringify(event),
        );
    });
  }

  close(): void {
    this.db.close();
  }
}
