import {
  BoundedRecoveryAgent,
  type DiagnosticModel,
  type RecoveryTraceSink,
} from '@nightorder/agent';
import {
  hasValidPlanHash,
  marketQuoteSchema,
  PersistentRecordsVerifierAdapter,
  tradePlanSchema,
  validatePlanTransition,
  type ExecutionPort,
  type MarketDataPort,
  type OrderAttempt,
  type OrderReadbackResult,
  type TradePlan,
  type ToolResult,
  type VerificationEvidenceReader,
} from '@nightorder/domain';
import { compareDecimalStrings } from '@nightorder/domain';
import type { QuoteEvaluation } from '../../../apps/worker/src/armed-plans.js';
import {
  buildPaperOrderRequest,
  requestDigestForPlan,
} from './order-request.js';
import type { IntegratedPlanRepository } from './sqlite-plan-repository.js';

export * from './order-request.js';
export * from './sqlite-plan-repository.js';

export interface PersistentWatcher {
  saveArmedPlan(plan: TradePlan): void;
  listArmedPlans(): Array<{ id: string }>;
  evaluateQuote(
    quote: import('@nightorder/domain').MarketQuote,
    maxAgeMs: number,
    now?: Date,
  ): QuoteEvaluation;
  getState(planId: string): 'ARMED' | 'TRIGGERED' | 'EXPIRED' | null;
  close(): void;
}

export interface RuntimeExecution
  extends ExecutionPort, VerificationEvidenceReader {
  getAttemptForPlan(planId: string): OrderAttempt | null;
  getOrderByClientId(clientOrderId: string): {
    status:
      | 'NEW'
      | 'PARTIALLY_FILLED'
      | 'FILLED'
      | 'CANCELED'
      | 'REJECTED'
      | 'EXPIRED';
    filledQuantity: string;
  } | null;
  countOrdersForPlan(planId: string): number;
}

export interface IntegratedRuntimeOptions {
  ownerId: string;
  plans: IntegratedPlanRepository;
  watcher: PersistentWatcher;
  market: MarketDataPort;
  execution: RuntimeExecution;
  model: DiagnosticModel;
  traces: RecoveryTraceSink;
  now?: () => Date;
  maxQuoteAgeMs?: number;
}

export interface RuntimePlanResult {
  planId: string;
  outcome:
    | 'ARMED'
    | 'WAITING'
    | 'BLOCKED'
    | 'SUBMITTED'
    | 'RECOVERED'
    | 'ESCALATED'
    | 'EXPIRED';
  planState?: TradePlan['state'];
  reason?: string;
  verification?: Awaited<
    ReturnType<PersistentRecordsVerifierAdapter['verify']>
  >;
  orderStatus?: string;
}

export interface RuntimePollResult {
  quoteKind: 'LIVE_PUBLIC' | 'TEST_FIXTURE' | 'UNAVAILABLE';
  quoteEvidenceId?: string;
  plans: RuntimePlanResult[];
}

function crossingSatisfied(
  plan: TradePlan,
  quote: import('@nightorder/domain').MarketQuote,
): boolean {
  return plan.side === 'BUY'
    ? compareDecimalStrings(quote.bestAsk, plan.triggerPrice) <= 0
    : compareDecimalStrings(quote.bestBid, plan.triggerPrice) >= 0;
}

function limitSatisfied(
  plan: TradePlan,
  quote: import('@nightorder/domain').MarketQuote,
): boolean {
  return plan.side === 'BUY'
    ? compareDecimalStrings(quote.bestAsk, plan.limitPrice) <= 0
    : compareDecimalStrings(quote.bestBid, plan.limitPrice) >= 0;
}

export class IntegratedTradingRuntime {
  private readonly now: () => Date;
  private readonly maxQuoteAgeMs: number;
  private readonly verifier: PersistentRecordsVerifierAdapter;
  private readonly recovery: BoundedRecoveryAgent;

  constructor(private readonly options: IntegratedRuntimeOptions) {
    this.now = options.now ?? (() => new Date());
    this.maxQuoteAgeMs = options.maxQuoteAgeMs ?? 5_000;
    this.verifier = new PersistentRecordsVerifierAdapter(options.execution);
    this.recovery = new BoundedRecoveryAgent(
      options.model,
      {
        loadAttempt: async (planId) =>
          options.execution.getAttemptForPlan(planId) ??
          options.plans.loadAttempt(planId),
        recordObservation: (planId, event) =>
          options.plans.recordObservation(planId, event),
        markNeedsHuman: (planId, reasonCode) =>
          options.plans.markNeedsHuman(planId, reasonCode),
      },
      options.execution,
      this.verifier,
      options.traces,
      { now: this.now },
    );
  }

  async pollOnce(): Promise<RuntimePollResult> {
    const results: RuntimePlanResult[] = [];
    const plans = (
      await this.options.plans.listPlansByOwner(this.options.ownerId)
    ).map((candidate) => tradePlanSchema.parse(candidate));

    // Reconcile persisted SUBMITTING attempts before watching for another trigger.
    for (const plan of plans.filter(
      (item) => item.state === 'SUBMITTING' || item.state === 'UNCERTAIN',
    )) {
      const attempt =
        this.options.execution.getAttemptForPlan(plan.id) ??
        (await this.options.plans.loadAttempt(plan.id));
      if (!attempt) {
        await this.options.plans.markNeedsHuman(plan.id, 'RECOVERY_UNCERTAIN');
        results.push({
          planId: plan.id,
          outcome: 'ESCALATED',
          reason: 'Persisted execution attempt is missing.',
          planState: plan.state,
        });
        continue;
      }
      const readback = await this.options.execution.findOrderByClientId(
        attempt.clientOrderId,
      );
      if (!readback.ok) {
        const outcome = await this.recovery.recover({
          planId: plan.id,
          operationId: attempt.operationId,
          clientOrderId: attempt.clientOrderId,
          failureCode:
            readback.code === 'TIMEOUT' || readback.code === 'NETWORK'
              ? readback.code
              : 'AMBIGUOUS',
          occurredAtUtc: this.now().toISOString(),
        });
        results.push({
          planId: plan.id,
          outcome: outcome.result === 'VERIFIED' ? 'RECOVERED' : 'ESCALATED',
          planState: plan.state,
          verification: outcome,
        });
        continue;
      }
      results.push(await this.finalizeFromReadback(plan, attempt, readback));
    }

    // Persist approved plans in the worker's existing durable watcher.
    for (const plan of plans.filter((item) => item.state === 'ARMED')) {
      if (
        !hasValidPlanHash(plan) ||
        !plan.approvedAtUtc ||
        plan.mode !== 'PAPER'
      ) {
        results.push({
          planId: plan.id,
          outcome: 'BLOCKED',
          planState: plan.state,
          reason: 'Plan authorization or PAPER mode is invalid.',
        });
        continue;
      }
      try {
        this.options.watcher.saveArmedPlan(plan);
        results.push({
          planId: plan.id,
          outcome: 'ARMED',
          planState: plan.state,
        });
      } catch (cause) {
        results.push({
          planId: plan.id,
          outcome: 'BLOCKED',
          planState: plan.state,
          reason:
            cause instanceof Error
              ? cause.message
              : 'Watcher persistence failed.',
        });
      }
    }

    const quoteResult = await this.options.market.currentQuote('BTCUSDT');
    if (!quoteResult.ok) return { quoteKind: 'UNAVAILABLE', plans: results };
    const quote = marketQuoteSchema.parse(quoteResult.data);
    const evaluation = this.options.watcher.evaluateQuote(
      quote,
      this.maxQuoteAgeMs,
      this.now(),
    );
    if (!evaluation.fresh) {
      return {
        quoteKind: quote.kind,
        quoteEvidenceId: quoteResult.evidenceId,
        plans: results,
      };
    }

    for (const planId of evaluation.expiredPlanIds) {
      const plan = await this.options.plans.loadPlan(planId);
      if (plan?.state === 'ARMED') {
        const transition = await this.options.plans.saveTransition(
          { ...plan, state: 'EXPIRED', revision: plan.revision + 1 },
          plan.revision,
          this.now().toISOString(),
        );
        results.push({
          planId,
          outcome: 'EXPIRED',
          planState: transition.ok ? transition.data.state : plan.state,
        });
      }
    }

    const triggerIds = new Set(evaluation.triggeredPlanIds);
    for (const original of plans.filter((item) => item.state === 'ARMED')) {
      const watcherState = this.options.watcher.getState(original.id);
      if (!triggerIds.has(original.id) && watcherState !== 'TRIGGERED')
        continue;
      const current = await this.options.plans.loadPlan(original.id);
      if (!current || current.state !== 'ARMED') continue;
      if (!crossingSatisfied(current, quote)) continue;
      const triggered = await this.options.plans.saveTransition(
        { ...current, state: 'TRIGGERED', revision: current.revision + 1 },
        current.revision,
        this.now().toISOString(),
      );
      if (!triggered.ok) {
        results.push({
          planId: current.id,
          outcome: 'BLOCKED',
          planState: current.state,
          reason: triggered.message,
        });
        continue;
      }
      const plan = triggered.data;
      if (!limitSatisfied(plan, quote)) {
        await this.options.plans.recordObservation(plan.id, {
          type: 'TRIGGER_BLOCKED_BY_LIMIT',
          quote,
          occurredAtUtc: this.now().toISOString(),
        });
        results.push({
          planId: plan.id,
          outcome: 'BLOCKED',
          planState: plan.state,
          reason:
            'Trigger crossed outside the approved limit; no execution claim was made.',
        });
        continue;
      }
      results.push(await this.executeTriggered(plan));
    }

    return {
      quoteKind: quote.kind,
      quoteEvidenceId: quoteResult.evidenceId,
      plans: results,
    };
  }

  private async executeTriggered(plan: TradePlan): Promise<RuntimePlanResult> {
    const attemptResult = await this.options.plans.claimForExecution(
      plan.id,
      plan.revision,
      `paper-order:${plan.id}`,
    );
    if (!attemptResult.ok)
      return {
        planId: plan.id,
        outcome: 'BLOCKED',
        planState: plan.state,
        reason: attemptResult.message,
      };
    const attempt = attemptResult.data;
    if (
      attempt.state !== 'PREPARED' ||
      attempt.planId !== plan.id ||
      attempt.operationId !== `paper-order:${plan.id}` ||
      attempt.requestDigest !== requestDigestForPlan(plan)
    ) {
      await this.options.plans.markNeedsHuman(plan.id, 'RECOVERY_UNCERTAIN');
      return {
        planId: plan.id,
        outcome: 'ESCALATED',
        planState: 'SUBMITTING',
        reason:
          'Persisted attempt does not match the approved bounded request.',
      };
    }
    let submitted: ToolResult<import('@nightorder/domain').OrderStatusResult>;
    try {
      submitted = await this.options.execution.submitApprovedOrder(
        buildPaperOrderRequest(plan, attempt.clientOrderId),
      );
    } catch {
      return this.recoverAfterFailure(plan, attempt, 'TIMEOUT');
    }
    if (!submitted.ok) {
      if (
        submitted.code === 'TIMEOUT' ||
        submitted.code === 'NETWORK' ||
        submitted.code === 'AMBIGUOUS'
      ) {
        return this.recoverAfterFailure(plan, attempt, submitted.code);
      }
      return this.transitionAndVerify(plan, attempt, 'REJECTED');
    }
    // The submit acknowledgement is not fill evidence. Always use durable readback.
    const readback = await this.options.execution.findOrderByClientId(
      attempt.clientOrderId,
    );
    if (!readback.ok)
      return this.recoverAfterFailure(
        plan,
        attempt,
        readback.code === 'TIMEOUT' || readback.code === 'NETWORK'
          ? readback.code
          : 'AMBIGUOUS',
      );
    return this.finalizeFromReadback(plan, attempt, readback);
  }

  private async recoverAfterFailure(
    plan: TradePlan,
    attempt: OrderAttempt,
    failureCode: 'TIMEOUT' | 'NETWORK' | 'AMBIGUOUS',
  ): Promise<RuntimePlanResult> {
    const recovery = await this.recovery.recover({
      planId: plan.id,
      operationId: attempt.operationId,
      clientOrderId: attempt.clientOrderId,
      failureCode,
      occurredAtUtc: this.now().toISOString(),
    });
    const persistedAttempt = this.options.execution.getAttemptForPlan(plan.id);
    if (persistedAttempt)
      this.options.plans.recordExecutionAttempt(persistedAttempt);
    if (recovery.result !== 'VERIFIED')
      return {
        planId: plan.id,
        outcome: 'ESCALATED',
        planState: 'SUBMITTING',
        verification: recovery,
      };
    const readback = await this.options.execution.findOrderByClientId(
      attempt.clientOrderId,
    );
    if (!readback.ok)
      return {
        planId: plan.id,
        outcome: 'ESCALATED',
        planState: 'SUBMITTING',
        verification: recovery,
        reason: 'Verifier passed but order readback remains unavailable.',
      };
    const finalized = await this.finalizeFromReadback(plan, attempt, readback);
    return { ...finalized, outcome: 'RECOVERED', verification: recovery };
  }

  private async finalizeFromReadback(
    plan: TradePlan,
    attempt: OrderAttempt,
    readback: ToolResult<OrderReadbackResult>,
  ): Promise<RuntimePlanResult> {
    if (!readback.ok)
      return {
        planId: plan.id,
        outcome: 'ESCALATED',
        planState: plan.state,
        reason: readback.message,
      };
    const state =
      readback.data.status === 'FILLED'
        ? 'FILLED'
        : readback.data.status === 'PARTIALLY_FILLED'
          ? 'PARTIALLY_FILLED'
          : ['NEW'].includes(readback.data.status)
            ? 'OPEN'
            : 'REJECTED';
    return this.transitionAndVerify(plan, attempt, state, readback.data.status);
  }

  private async transitionAndVerify(
    plan: TradePlan,
    attempt: OrderAttempt,
    state: 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'REJECTED',
    orderStatus?: string,
  ): Promise<RuntimePlanResult> {
    const latest = await this.options.plans.loadPlan(plan.id);
    if (!latest)
      return {
        planId: plan.id,
        outcome: 'ESCALATED',
        reason: 'Plan disappeared after execution.',
      };
    if (latest.state === 'SUBMITTING') {
      const next = validatePlanTransition(
        latest,
        { ...latest, state, revision: latest.revision + 1 },
        this.now().toISOString(),
      );
      const saved = await this.options.plans.saveTransition(
        next,
        latest.revision,
        this.now().toISOString(),
      );
      if (!saved.ok)
        return {
          planId: plan.id,
          outcome: 'ESCALATED',
          planState: latest.state,
          reason: saved.message,
        };
    }
    const persistedAttempt = this.options.execution.getAttemptForPlan(plan.id);
    if (persistedAttempt)
      this.options.plans.recordExecutionAttempt(persistedAttempt);
    const verification = await this.verifier.verify(plan.id);
    if (verification.result !== 'VERIFIED') {
      await this.options.plans.markNeedsHuman(plan.id, 'VERIFICATION_BLOCKED');
      const escalatedPlan = await this.options.plans.loadPlan(plan.id);
      return {
        planId: plan.id,
        outcome: 'ESCALATED',
        ...(escalatedPlan ? { planState: escalatedPlan.state } : {}),
        verification,
        reason: 'Independent persisted-evidence verification did not pass.',
      };
    }
    const finalizedPlan = await this.options.plans.loadPlan(plan.id);
    return {
      planId: plan.id,
      outcome: 'SUBMITTED',
      ...(finalizedPlan ? { planState: finalizedPlan.state } : {}),
      verification,
      ...(orderStatus ? { orderStatus } : {}),
    };
  }
}
