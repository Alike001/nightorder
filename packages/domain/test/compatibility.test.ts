import { describe, expect, it } from 'vitest';
import {
  PersistentRecordsVerifierAdapter,
  StalePlanRevisionError,
  assertEscalationRevision,
  digestPersistentPaperOrderRequest,
  isPlanTransitionAllowed,
  mapPaperCancelAcknowledgement,
  mapPaperOrderReadback,
  mapSqlitePaperOrderAttempt,
  markNeedsHumanResultSchema,
  needsHumanIdempotencyKey,
  orderAttemptSchema,
  verifyPersistentRecords,
  type OrderAttempt,
  type PersistentPaperOrder,
  type TradePlan,
  type VerificationEvidenceSnapshot,
} from '../src/index.js';
import { armedPlan } from './fixtures.js';

const CREATED_AT = '2026-10-10T20:00:01.000Z';

function submittingPlan(overrides: Partial<TradePlan> = {}): TradePlan {
  return {
    ...armedPlan(),
    state: 'SUBMITTING',
    revision: 4,
    ...overrides,
  };
}

function records(
  options: {
    plan?: TradePlan;
    status?: PersistentPaperOrder['status'];
  } = {},
): VerificationEvidenceSnapshot {
  const plan = options.plan ?? submittingPlan();
  const orderWithoutDigest = {
    orderId: 'paper-order-1',
    planId: plan.id,
    clientOrderId: 'nightorder-plan-001',
    symbol: plan.symbol,
    side: plan.side,
    quantity: '0.0008',
    limitPrice: plan.limitPrice,
    status: options.status ?? 'NEW',
    filledQuantity: '0',
    createdAtUtc: CREATED_AT,
    updatedAtUtc: CREATED_AT,
  } as const;
  const requestDigest = digestPersistentPaperOrderRequest(
    orderWithoutDigest,
    plan.planHash,
  );
  const reconciled = orderWithoutDigest.status === 'CANCELED';
  const attempt: OrderAttempt = {
    id: 'attempt-1',
    planId: plan.id,
    operationId: 'paper-order:plan-001',
    clientOrderId: orderWithoutDigest.clientOrderId,
    requestDigest,
    remoteOrderId: orderWithoutDigest.orderId,
    state: reconciled ? 'RECONCILED' : 'ACKNOWLEDGED',
    venueStatus: orderWithoutDigest.status,
    evidenceSource: 'ORIGINAL_PAPER',
    createdAtUtc: CREATED_AT,
    ...(reconciled ? { reconciledAtUtc: '2026-10-10T20:00:02.000Z' } : {}),
  };
  return {
    plan: { evidenceId: 'plan-row-1', data: plan },
    authorization: {
      evidenceId: 'approval-row-1',
      data: {
        planId: plan.id,
        ownerId: plan.ownerId,
        planHash: plan.planHash,
        approvedAtUtc: plan.approvedAtUtc!,
      },
    },
    attempts: { evidenceId: 'attempt-query-1', data: [attempt] },
    order: {
      evidenceId: 'order-row-1',
      data: { ...orderWithoutDigest, requestDigest },
    },
  };
}

describe('recovery escalation compatibility', () => {
  it('keeps potentially active order states visible instead of relabeling them', () => {
    for (const state of ['UNCERTAIN', 'CANCEL_REQUESTED'] as const) {
      expect(isPlanTransitionAllowed(state, 'NEEDS_HUMAN')).toBe(false);
    }
  });

  it('rejects a stale revision before an escalation record is inserted', () => {
    expect(() => assertEscalationRevision(8, 7)).toThrow(
      StalePlanRevisionError,
    );
    expect(() => assertEscalationRevision(8, 8)).not.toThrow();
  });

  it('represents failed escalation persistence as a typed failure, not success', () => {
    expect(
      markNeedsHumanResultSchema.parse({
        ok: false,
        code: 'PERSISTENCE_FAILED',
        message: 'Escalation transaction did not commit',
        retrySafe: true,
        evidenceId: 'escalation-write-1',
      }),
    ).toMatchObject({ ok: false, code: 'PERSISTENCE_FAILED' });
  });

  it('makes the plan and reason pair the validated idempotency key', () => {
    const record = {
      id: 'escalation-1',
      planId: 'plan-001',
      reasonCode: 'RECOVERY_UNCERTAIN' as const,
      idempotencyKey: needsHumanIdempotencyKey(
        'plan-001',
        'RECOVERY_UNCERTAIN',
      ),
      status: 'OPEN' as const,
      planStateAtEscalation: 'UNCERTAIN' as const,
      planRevisionAtEscalation: 5,
      createdAtUtc: '2026-10-10T20:00:03.000Z',
    };
    expect(
      markNeedsHumanResultSchema.parse({
        ok: true,
        data: record,
        evidenceId: record.id,
      }),
    ).toMatchObject({ ok: true, data: record });
    expect(
      markNeedsHumanResultSchema.safeParse({
        ok: true,
        data: { ...record, idempotencyKey: 'different-key' },
        evidenceId: record.id,
      }).success,
    ).toBe(false);
  });
});

describe('SQLite attempt compatibility mapping', () => {
  it('maps every persisted field explicitly without inventing reconciliation time', () => {
    const mapped = mapSqlitePaperOrderAttempt({
      id: 'attempt-1',
      planId: 'plan-001',
      operationId: 'paper-order:plan-001',
      clientOrderId: 'nightorder-plan-001',
      requestDigest: 'a'.repeat(64),
      state: 'ACKNOWLEDGED',
      venueStatus: 'NEW',
      evidenceSource: 'ORIGINAL_PAPER',
      createdAtUtc: CREATED_AT,
      orderId: 'paper-order-1',
    });
    expect(mapped).toMatchObject({
      id: 'attempt-1',
      operationId: 'paper-order:plan-001',
      remoteOrderId: 'paper-order-1',
      venueStatus: 'NEW',
      evidenceSource: 'ORIGINAL_PAPER',
      createdAtUtc: CREATED_AT,
    });
    expect(mapped).not.toHaveProperty('orderId');
    expect(mapped).not.toHaveProperty('reconciledAtUtc');
  });

  it('rejects missing evidence and unknown venue status', () => {
    const base = {
      id: 'attempt-1',
      planId: 'plan-001',
      operationId: 'paper-order:plan-001',
      clientOrderId: 'nightorder-plan-001',
      requestDigest: 'a'.repeat(64),
      state: 'ACKNOWLEDGED',
      evidenceSource: 'ORIGINAL_PAPER',
      createdAtUtc: CREATED_AT,
      orderId: 'paper-order-1',
    };
    expect(() => mapSqlitePaperOrderAttempt(base)).toThrow();
    expect(() =>
      mapSqlitePaperOrderAttempt({ ...base, venueStatus: 'UNKNOWN' }),
    ).toThrow();
  });
});

describe('independent persistent-record verifier', () => {
  it('verifies a timeout-after-commit from durable plan, attempt and order rows', async () => {
    const adapter = new PersistentRecordsVerifierAdapter({
      loadVerificationEvidence: async () => records(),
    });
    const result = await adapter.verify('plan-001');
    expect(result.result).toBe('VERIFIED');
    expect(Object.keys(result.checks)).toHaveLength(9);
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
  });

  it('fails closed without padding unavailable evidence checks with true', () => {
    const result = verifyPersistentRecords({
      plan: records().plan,
    });
    expect(result.result).toBe('UNCERTAIN');
    expect(result.checks.ORDER_ATTEMPT_UNIQUE).toBe(false);
    expect(result.checks.ORDER_REQUEST_MATCHES_PLAN).toBe(false);
    expect(result.checks.EXECUTION_STATUS_MATCHES).toBe(false);
    expect(result.evidenceIds).toEqual(['plan-row-1']);
  });

  it('returns nine failed canonical checks for malformed unknown status evidence', () => {
    const snapshot = records() as Record<string, unknown>;
    const order = snapshot.order as {
      evidenceId: string;
      data: Record<string, unknown>;
    };
    order.data.status = 'UNKNOWN';
    const result = verifyPersistentRecords(snapshot);
    expect(result.result).toBe('UNCERTAIN');
    expect(Object.keys(result.checks)).toHaveLength(9);
    expect(Object.values(result.checks).every((value) => !value)).toBe(true);
  });

  it('blocks when durable plan state contradicts the order and attempt status', () => {
    const result = verifyPersistentRecords(
      records({ plan: submittingPlan({ state: 'FILLED', revision: 6 }) }),
    );
    expect(result.result).toBe('BLOCKED');
    expect(result.checks.EXECUTION_STATUS_MATCHES).toBe(false);
  });
});

describe('cancellation command and readback semantics', () => {
  it('adapts immediate SQLite CANCELED to acknowledgement only', () => {
    expect(mapPaperCancelAcknowledgement({ status: 'CANCELED' })).toEqual({
      status: 'CANCEL_REQUESTED',
    });
  });

  it('accepts CANCELED only from separate order readback', () => {
    expect(
      mapPaperOrderReadback({
        orderId: 'paper-order-1',
        status: 'CANCELED',
        filledQuantity: '0',
      }).status,
    ).toBe('CANCELED');
  });

  it('verifies a cancelled order only after the plan and attempt reflect readback', () => {
    const requested = records({
      plan: submittingPlan({ state: 'CANCEL_REQUESTED', revision: 6 }),
      status: 'CANCELED',
    });
    expect(verifyPersistentRecords(requested).result).toBe('BLOCKED');

    const confirmed = records({
      plan: submittingPlan({ state: 'CANCELLED', revision: 7 }),
      status: 'CANCELED',
    });
    expect(verifyPersistentRecords(confirmed).result).toBe('VERIFIED');
  });

  it('keeps canonical attempt validation strict for confirmed cancellation', () => {
    expect(
      orderAttemptSchema.safeParse(
        records({
          plan: submittingPlan({ state: 'CANCELLED', revision: 7 }),
          status: 'CANCELED',
        }).attempts?.data[0],
      ).success,
    ).toBe(true);
  });
});
