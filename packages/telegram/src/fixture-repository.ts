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
import type { Clock, TelegramPlanRepository } from './contracts.js';

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** In-memory persistence fixture for Telegram development and contract tests. */
export class InMemoryTelegramPlanRepository implements TelegramPlanRepository {
  private readonly plans = new Map<string, TradePlan>();
  private readonly attempts = new Map<string, OrderAttempt>();
  private readonly observations = new Map<
    string,
    Readonly<Record<string, unknown>>[]
  >();
  private evidenceSequence = 0;

  constructor(private readonly clock: Clock) {}

  async createDraft(planInput: TradePlan): Promise<void> {
    const plan = tradePlanSchema.parse(planInput);
    if (plan.state !== 'DRAFT' || plan.revision !== 0) {
      throw new Error('createDraft requires a revision-zero DRAFT plan');
    }
    if (this.plans.has(plan.id)) {
      throw new Error(`Plan ${plan.id} already exists`);
    }
    this.plans.set(plan.id, clone(plan));
  }

  async listPlansByOwner(ownerId: string): Promise<readonly TradePlan[]> {
    return [...this.plans.values()]
      .filter((plan) => plan.ownerId === ownerId)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(clone);
  }

  async loadPlan(planId: string): Promise<TradePlan | null> {
    const plan = this.plans.get(planId);
    return plan ? clone(plan) : null;
  }

  async loadAttempt(planId: string): Promise<OrderAttempt | null> {
    const attempt = this.attempts.get(planId);
    return attempt ? clone(attempt) : null;
  }

  async saveTransition(
    nextInput: TradePlan,
    expectedRevision: number,
    transitionedAtUtc: string,
  ): Promise<ToolResult<TradePlan>> {
    const current = this.plans.get(nextInput.id);
    if (!current) return this.failure('NOT_FOUND', 'Plan not found', false);
    if (current.revision !== expectedRevision) {
      return this.failure(
        'AMBIGUOUS',
        'Plan revision changed; reload before continuing',
        false,
      );
    }

    try {
      const next = validatePlanTransition(
        current,
        nextInput,
        transitionedAtUtc,
      );
      this.plans.set(next.id, clone(next));
      return this.success(next);
    } catch (error) {
      return this.failure(
        'REJECTED',
        error instanceof Error ? error.message : 'Invalid plan transition',
        false,
      );
    }
  }

  async approveExact(
    planId: string,
    ownerId: string,
    expectedHash: string,
  ): Promise<ToolResult<TradePlan>> {
    const current = this.plans.get(planId);
    if (!current) return this.failure('NOT_FOUND', 'Plan not found', false);
    return this.approveExactAtRevision(
      planId,
      ownerId,
      expectedHash,
      current.revision,
      this.clock.nowUtc(),
    );
  }

  async approveExactAtRevision(
    planId: string,
    ownerId: string,
    expectedHash: string,
    expectedRevision: number,
    approvedAtUtcInput: string,
  ): Promise<ToolResult<TradePlan>> {
    const approvedAtUtc = utcTimestampSchema.parse(approvedAtUtcInput);
    const current = this.plans.get(planId);
    if (!current) return this.failure('NOT_FOUND', 'Plan not found', false);
    if (current.ownerId !== ownerId) {
      return this.failure(
        'UNAUTHORIZED',
        'Only the plan owner may approve it',
        false,
      );
    }
    if (current.revision !== expectedRevision) {
      return this.failure(
        'AMBIGUOUS',
        'Plan revision changed; inspect a fresh preview',
        false,
      );
    }
    if (current.planHash !== expectedHash) {
      return this.failure(
        'UNAUTHORIZED',
        'Approval digest does not match the current plan',
        false,
      );
    }
    if (current.state !== 'AWAITING_CONFIRMATION') {
      return this.failure(
        'REJECTED',
        `Plan cannot be approved from ${current.state}`,
        false,
      );
    }
    if (compareUtcTimestamps(approvedAtUtc, current.expiresAtUtc) >= 0) {
      return this.failure('EXPIRED', 'Plan expired before approval', false);
    }

    return this.saveTransition(
      {
        ...current,
        approvedAtUtc,
        state: 'ARMED',
        revision: current.revision + 1,
      },
      expectedRevision,
      approvedAtUtc,
    );
  }

  async cancelOwnedAtRevision(
    planId: string,
    ownerId: string,
    expectedRevision: number,
    requestedAtUtcInput: string,
  ): Promise<ToolResult<TradePlan>> {
    const requestedAtUtc = utcTimestampSchema.parse(requestedAtUtcInput);
    const current = this.plans.get(planId);
    if (!current) return this.failure('NOT_FOUND', 'Plan not found', false);
    if (current.ownerId !== ownerId) {
      return this.failure(
        'UNAUTHORIZED',
        'Only the plan owner may cancel it',
        false,
      );
    }
    if (current.revision !== expectedRevision) {
      return this.failure(
        'AMBIGUOUS',
        'Plan revision changed; reload before cancelling',
        false,
      );
    }

    if (current.state === 'CANCEL_REQUESTED' || current.state === 'CANCELLED') {
      return this.success(current);
    }
    if (current.state === 'ARMED' || current.state === 'TRIGGERED') {
      const state =
        compareUtcTimestamps(requestedAtUtc, current.expiresAtUtc) >= 0
          ? 'EXPIRED'
          : 'CANCELLED';
      return this.saveTransition(
        { ...current, state, revision: current.revision + 1 },
        expectedRevision,
        requestedAtUtc,
      );
    }
    if (current.state === 'OPEN' || current.state === 'PARTIALLY_FILLED') {
      return this.saveTransition(
        {
          ...current,
          state: 'CANCEL_REQUESTED',
          revision: current.revision + 1,
        },
        expectedRevision,
        requestedAtUtc,
      );
    }

    return this.failure(
      'REJECTED',
      `Cancellation cannot be requested from ${current.state}`,
      false,
    );
  }

  async claimForExecution(
    planId: string,
    expectedRevision: number,
    operationId: string,
  ): Promise<ToolResult<OrderAttempt>> {
    const current = this.plans.get(planId);
    if (!current) return this.failure('NOT_FOUND', 'Plan not found', false);
    if (current.revision !== expectedRevision) {
      return this.failure('AMBIGUOUS', 'Plan revision changed', false);
    }
    if (current.state !== 'TRIGGERED') {
      return this.failure(
        'REJECTED',
        'Only TRIGGERED plans can be claimed',
        false,
      );
    }
    const existing = this.attempts.get(planId);
    if (existing) return this.success(existing);

    const nowUtc = utcTimestampSchema.parse(this.clock.nowUtc());
    const transition = await this.saveTransition(
      {
        ...current,
        state: 'SUBMITTING',
        revision: current.revision + 1,
      },
      expectedRevision,
      nowUtc,
    );
    if (!transition.ok) return transition;

    const attempt = orderAttemptSchema.parse({
      id: `attempt-${operationId}`,
      planId,
      operationId,
      clientOrderId: `nightorder-${planId}`,
      requestDigest: current.planHash,
      state: 'PREPARED',
      evidenceSource: 'ORIGINAL_PAPER',
      createdAtUtc: nowUtc,
    });
    this.attempts.set(planId, clone(attempt));
    return this.success(attempt);
  }

  async recordObservation(
    planId: string,
    event: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    if (!this.plans.has(planId)) throw new Error(`Plan ${planId} not found`);
    const observations = this.observations.get(planId) ?? [];
    observations.push(clone(event));
    this.observations.set(planId, observations);
  }

  seedPlan(planInput: TradePlan): void {
    const plan = tradePlanSchema.parse(planInput);
    this.plans.set(plan.id, clone(plan));
  }

  seedAttempt(attemptInput: OrderAttempt): void {
    const attempt = orderAttemptSchema.parse(attemptInput);
    this.attempts.set(attempt.planId, clone(attempt));
  }

  observationsFor(
    planId: string,
  ): readonly Readonly<Record<string, unknown>>[] {
    return clone(this.observations.get(planId) ?? []);
  }

  private success<T>(data: T): ToolResult<T> {
    return {
      ok: true,
      data: clone(data),
      evidenceId: this.nextEvidenceId(),
    };
  }

  private failure<T>(
    code: ToolErrorCode,
    message: string,
    retrySafe: boolean,
  ): ToolResult<T> {
    return {
      ok: false,
      code,
      message,
      retrySafe,
      evidenceId: this.nextEvidenceId(),
    };
  }

  private nextEvidenceId(): string {
    this.evidenceSequence += 1;
    return `telegram-fixture-evidence-${this.evidenceSequence}`;
  }
}
