import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  compareUtcTimestamps,
  needsHumanEscalationSchema,
  needsHumanIdempotencyKey,
  orderAttemptSchema,
  tradePlanSchema,
  utcTimestampSchema,
  validatePlanTransition,
  type NeedsHumanEscalation,
  type NeedsHumanReasonCode,
  type OrderAttempt,
  type PlanRepository,
  type ToolErrorCode,
  type ToolResult,
  type TradePlan,
  type VerificationEvidenceSnapshot,
} from '@nightorder/domain';
import { requestDigestForPlan } from './order-request.js';

const evidenceIdSchema = needsHumanEscalationSchema.shape.id;

export interface IntegratedPlanRepository extends PlanRepository {
  listPlansByOwner(ownerId: string): Promise<readonly TradePlan[]>;
  saveTransition(
    plan: TradePlan,
    expectedRevision: number,
    transitionedAtUtc: string,
  ): Promise<ToolResult<TradePlan>>;
  approveExactAtRevision(
    planId: string,
    ownerId: string,
    expectedHash: string,
    expectedRevision: number,
    approvedAtUtc: string,
  ): Promise<ToolResult<TradePlan>>;
  cancelOwnedAtRevision(
    planId: string,
    ownerId: string,
    expectedRevision: number,
    requestedAtUtc: string,
  ): Promise<ToolResult<TradePlan>>;
  recordExecutionAttempt(attempt: OrderAttempt): void;
}

export interface SqlitePlanRepositoryOptions {
  readonly databasePath: string;
  readonly now?: () => Date;
}

function immediateTransaction<T>(database: DatabaseSync, action: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const value = action();
    database.exec('COMMIT');
    return value;
  } catch (cause) {
    database.exec('ROLLBACK');
    throw cause;
  }
}

export class SqliteTradingPlanRepository implements IntegratedPlanRepository {
  private readonly database: DatabaseSync;
  private readonly now: () => Date;

  constructor(options: SqlitePlanRepositoryOptions) {
    this.database = new DatabaseSync(options.databasePath);
    this.now = options.now ?? (() => new Date());
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS trade_plans (
        plan_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        state TEXT NOT NULL,
        revision INTEGER NOT NULL,
        plan_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS plan_authorizations (
        evidence_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL UNIQUE REFERENCES trade_plans(plan_id),
        owner_id TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        approved_at_utc TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS runtime_attempt_claims (
        plan_id TEXT PRIMARY KEY REFERENCES trade_plans(plan_id),
        attempt_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS needs_human_escalations (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES trade_plans(plan_id),
        reason_code TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status = 'OPEN'),
        plan_state_at_escalation TEXT NOT NULL,
        plan_revision_at_escalation INTEGER NOT NULL,
        created_at_utc TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS runtime_observations (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES trade_plans(plan_id),
        event_json TEXT NOT NULL,
        created_at_utc TEXT NOT NULL
      ) STRICT;
    `);
  }

  async createDraft(planInput: TradePlan): Promise<void> {
    const plan = tradePlanSchema.parse(planInput);
    if (plan.state !== 'DRAFT' || plan.revision !== 0) {
      throw new Error('createDraft requires a revision-zero DRAFT plan.');
    }
    this.database
      .prepare(
        'INSERT INTO trade_plans (plan_id, owner_id, state, revision, plan_json) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        plan.id,
        plan.ownerId,
        plan.state,
        plan.revision,
        JSON.stringify(plan),
      );
  }

  async listPlansByOwner(ownerId: string): Promise<readonly TradePlan[]> {
    const rows = this.database
      .prepare(
        'SELECT plan_json FROM trade_plans WHERE owner_id = ? ORDER BY plan_id',
      )
      .all(ownerId) as Array<{ plan_json: string }>;
    return rows.map((row) => tradePlanSchema.parse(JSON.parse(row.plan_json)));
  }

  async loadPlan(planId: string): Promise<TradePlan | null> {
    const row = this.database
      .prepare('SELECT plan_json FROM trade_plans WHERE plan_id = ?')
      .get(planId) as { plan_json: string } | undefined;
    return row ? tradePlanSchema.parse(JSON.parse(row.plan_json)) : null;
  }

  async loadAttempt(planId: string): Promise<OrderAttempt | null> {
    const row = this.database
      .prepare(
        'SELECT attempt_json FROM runtime_attempt_claims WHERE plan_id = ?',
      )
      .get(planId) as { attempt_json: string } | undefined;
    return row ? orderAttemptSchema.parse(JSON.parse(row.attempt_json)) : null;
  }

  async saveTransition(
    nextInput: TradePlan,
    expectedRevision: number,
    transitionedAtUtcInput: string,
  ): Promise<ToolResult<TradePlan>> {
    return immediateTransaction(this.database, () => {
      const current = this.loadPlanSync(nextInput.id);
      if (!current) return this.failure('NOT_FOUND', 'Plan not found.');
      if (current.revision !== expectedRevision) {
        return this.failure('STALE_REVISION', 'Plan revision changed.');
      }
      try {
        const next = validatePlanTransition(
          current,
          nextInput,
          transitionedAtUtcInput,
        );
        this.writePlan(next, expectedRevision);
        return this.success(
          next,
          evidenceIdSchema.parse(
            next.id,
          ) as `${string}-${string}-${string}-${string}-${string}`,
        );
      } catch (cause) {
        return this.failure(
          'REJECTED',
          cause instanceof Error ? cause.message : 'Invalid plan transition.',
        );
      }
    });
  }

  async approveExact(
    planId: string,
    ownerId: string,
    expectedHash: string,
  ): Promise<ToolResult<TradePlan>> {
    const current = this.loadPlanSync(planId);
    if (!current) return this.failure('NOT_FOUND', 'Plan not found.');
    return this.approveExactAtRevision(
      planId,
      ownerId,
      expectedHash,
      current.revision,
      this.now().toISOString(),
    );
  }

  async approveExactAtRevision(
    planId: string,
    ownerId: string,
    expectedHash: string,
    expectedRevision: number,
    approvedAtUtcInput: string,
  ): Promise<ToolResult<TradePlan>> {
    return immediateTransaction(this.database, () => {
      const current = this.loadPlanSync(planId);
      if (!current) return this.failure('NOT_FOUND', 'Plan not found.');
      if (current.ownerId !== ownerId) {
        return this.failure(
          'UNAUTHORIZED',
          'Only the plan owner may approve it.',
        );
      }
      if (current.revision !== expectedRevision) {
        return this.failure('STALE_REVISION', 'Plan revision changed.');
      }
      if (current.planHash !== expectedHash) {
        return this.failure(
          'UNAUTHORIZED',
          'Approval hash does not match the plan.',
        );
      }
      if (current.state !== 'AWAITING_CONFIRMATION') {
        return this.failure('REJECTED', 'Plan is not awaiting confirmation.');
      }

      try {
        const approvedAtUtc = utcTimestampSchema.parse(approvedAtUtcInput);
        if (compareUtcTimestamps(approvedAtUtc, current.expiresAtUtc) >= 0) {
          return this.failure('EXPIRED', 'Plan expired before approval.');
        }
        // Approval is a single persisted transition from awaiting to armed.
        const armed = tradePlanSchema.parse({
          ...current,
          approvedAtUtc,
          state: 'ARMED',
          revision: current.revision + 1,
        });
        validatePlanTransition(current, armed, approvedAtUtc);
        this.writePlan(armed, expectedRevision);
        const evidenceId = randomUUID();
        this.database
          .prepare(
            'INSERT INTO plan_authorizations (evidence_id, plan_id, owner_id, plan_hash, approved_at_utc) VALUES (?, ?, ?, ?, ?)',
          )
          .run(evidenceId, planId, ownerId, expectedHash, approvedAtUtc);
        return this.success(armed, evidenceId);
      } catch (cause) {
        return this.failure(
          'REJECTED',
          cause instanceof Error ? cause.message : 'Plan approval failed.',
        );
      }
    });
  }

  async claimForExecution(
    planId: string,
    expectedRevision: number,
    operationId: string,
  ): Promise<ToolResult<OrderAttempt>> {
    return immediateTransaction(this.database, () => {
      const current = this.loadPlanSync(planId);
      if (!current) return this.failure('NOT_FOUND', 'Plan not found.');
      if (current.revision !== expectedRevision) {
        return this.failure('STALE_REVISION', 'Plan revision changed.');
      }
      if (current.state !== 'TRIGGERED') {
        return this.failure('REJECTED', 'Only triggered plans may be claimed.');
      }
      if (!current.approvedAtUtc || current.mode !== 'PAPER') {
        return this.failure(
          'UNAUTHORIZED',
          'Plan is not approved for PAPER execution.',
        );
      }
      const existing = this.database
        .prepare(
          'SELECT attempt_json FROM runtime_attempt_claims WHERE plan_id = ?',
        )
        .get(planId) as { attempt_json: string } | undefined;
      if (existing) {
        return this.success(
          orderAttemptSchema.parse(JSON.parse(existing.attempt_json)),
        );
      }

      const createdAtUtc = utcTimestampSchema.parse(this.now().toISOString());
      const attempt = orderAttemptSchema.parse({
        id: randomUUID(),
        planId,
        operationId,
        clientOrderId: `nightorder-${planId}`,
        requestDigest: requestDigestForPlan(current),
        state: 'PREPARED',
        evidenceSource: 'ORIGINAL_PAPER',
        createdAtUtc,
      });
      const next = validatePlanTransition(
        current,
        {
          ...current,
          state: 'SUBMITTING',
          revision: current.revision + 1,
        },
        createdAtUtc,
      );
      this.writePlan(next, expectedRevision);
      this.database
        .prepare(
          'INSERT INTO runtime_attempt_claims (plan_id, attempt_json) VALUES (?, ?)',
        )
        .run(planId, JSON.stringify(attempt));
      return this.success(
        attempt,
        evidenceIdSchema.parse(
          attempt.id,
        ) as `${string}-${string}-${string}-${string}-${string}`,
      );
    });
  }

  async cancelOwnedAtRevision(
    planId: string,
    ownerId: string,
    expectedRevision: number,
    requestedAtUtcInput: string,
  ): Promise<ToolResult<TradePlan>> {
    return immediateTransaction(this.database, () => {
      const current = this.loadPlanSync(planId);
      if (!current) return this.failure('NOT_FOUND', 'Plan not found.');
      if (current.ownerId !== ownerId) {
        return this.failure(
          'UNAUTHORIZED',
          'Only the plan owner may cancel it.',
        );
      }
      if (current.revision !== expectedRevision) {
        return this.failure('STALE_REVISION', 'Plan revision changed.');
      }
      try {
        const requestedAtUtc = utcTimestampSchema.parse(requestedAtUtcInput);
        if (current.state !== 'ARMED' && current.state !== 'TRIGGERED') {
          return this.failure(
            'REJECTED',
            'Plan cannot be cancelled in its current state.',
          );
        }
        const next = validatePlanTransition(
          current,
          { ...current, state: 'CANCELLED', revision: current.revision + 1 },
          requestedAtUtc,
        );
        this.writePlan(next, expectedRevision);
        return this.success(next);
      } catch (cause) {
        return this.failure(
          'REJECTED',
          cause instanceof Error ? cause.message : 'Plan cancellation failed.',
        );
      }
    });
  }

  async markNeedsHuman(
    planId: string,
    reasonCode: NeedsHumanReasonCode,
  ): Promise<ToolResult<NeedsHumanEscalation>> {
    return immediateTransaction(this.database, () => {
      const current = this.loadPlanSync(planId);
      if (!current) return this.failure('NOT_FOUND', 'Plan not found.');
      const idempotencyKey = needsHumanIdempotencyKey(planId, reasonCode);
      const existing = this.database
        .prepare(
          'SELECT * FROM needs_human_escalations WHERE idempotency_key = ?',
        )
        .get(idempotencyKey) as Record<string, unknown> | undefined;
      if (existing) {
        return this.success(
          this.escalationFromRow(existing),
          String(
            existing.id,
          ) as `${string}-${string}-${string}-${string}-${string}`,
        );
      }
      const id = randomUUID();
      const escalation = needsHumanEscalationSchema.parse({
        id,
        planId,
        reasonCode,
        idempotencyKey,
        status: 'OPEN',
        planStateAtEscalation: current.state,
        planRevisionAtEscalation: current.revision,
        createdAtUtc: this.now().toISOString(),
      });
      this.database
        .prepare(
          `INSERT INTO needs_human_escalations (
            id, plan_id, reason_code, idempotency_key, status,
            plan_state_at_escalation, plan_revision_at_escalation, created_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          escalation.id,
          escalation.planId,
          escalation.reasonCode,
          escalation.idempotencyKey,
          escalation.status,
          escalation.planStateAtEscalation,
          escalation.planRevisionAtEscalation,
          escalation.createdAtUtc,
        );
      return this.success(escalation, id);
    });
  }

  async recordObservation(
    planId: string,
    event: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    this.database
      .prepare(
        'INSERT INTO runtime_observations (id, plan_id, event_json, created_at_utc) VALUES (?, ?, ?, ?)',
      )
      .run(
        randomUUID(),
        planId,
        JSON.stringify(event),
        this.now().toISOString(),
      );
  }

  loadPlanEvidence(planId: string): VerificationEvidenceSnapshot['plan'] {
    const plan = this.loadPlanSync(planId);
    return plan ? { evidenceId: planId, data: plan } : undefined;
  }

  loadAuthorizationEvidence(
    planId: string,
  ): VerificationEvidenceSnapshot['authorization'] {
    const row = this.database
      .prepare(
        'SELECT evidence_id, plan_id, owner_id, plan_hash, approved_at_utc FROM plan_authorizations WHERE plan_id = ?',
      )
      .get(planId) as
      | {
          evidence_id: string;
          plan_id: string;
          owner_id: string;
          plan_hash: string;
          approved_at_utc: string;
        }
      | undefined;
    return row
      ? {
          evidenceId: row.evidence_id,
          data: {
            planId: row.plan_id,
            ownerId: row.owner_id,
            planHash: row.plan_hash,
            approvedAtUtc: row.approved_at_utc,
          },
        }
      : undefined;
  }

  recordExecutionAttempt(attemptInput: OrderAttempt): void {
    const attempt = orderAttemptSchema.parse(attemptInput);
    this.database
      .prepare(
        'INSERT INTO runtime_attempt_claims (plan_id, attempt_json) VALUES (?, ?) ON CONFLICT(plan_id) DO UPDATE SET attempt_json = excluded.attempt_json',
      )
      .run(attempt.planId, JSON.stringify(attempt));
  }

  close(): void {
    this.database.close();
  }

  private loadPlanSync(planId: string): TradePlan | null {
    const row = this.database
      .prepare('SELECT plan_json FROM trade_plans WHERE plan_id = ?')
      .get(planId) as { plan_json: string } | undefined;
    return row ? tradePlanSchema.parse(JSON.parse(row.plan_json)) : null;
  }

  private writePlan(plan: TradePlan, expectedRevision: number): void {
    const result = this.database
      .prepare(
        `UPDATE trade_plans SET owner_id = ?, state = ?, revision = ?, plan_json = ?
         WHERE plan_id = ? AND revision = ?`,
      )
      .run(
        plan.ownerId,
        plan.state,
        plan.revision,
        JSON.stringify(plan),
        plan.id,
        expectedRevision,
      );
    if (Number(result.changes) !== 1) {
      throw new Error('Plan revision changed during transition.');
    }
  }

  private escalationFromRow(
    row: Record<string, unknown>,
  ): NeedsHumanEscalation {
    return needsHumanEscalationSchema.parse({
      id: row.id,
      planId: row.plan_id,
      reasonCode: row.reason_code,
      idempotencyKey: row.idempotency_key,
      status: row.status,
      planStateAtEscalation: row.plan_state_at_escalation,
      planRevisionAtEscalation: row.plan_revision_at_escalation,
      createdAtUtc: row.created_at_utc,
    });
  }

  private success<T>(data: T, evidenceId = randomUUID()): ToolResult<T> {
    return { ok: true, data, evidenceId };
  }

  private failure<T>(code: ToolErrorCode, message: string): ToolResult<T> {
    return {
      ok: false,
      code,
      message,
      retrySafe: false,
      evidenceId: randomUUID(),
    };
  }
}
