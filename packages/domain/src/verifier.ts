import { createHash } from 'node:crypto';
import { z } from 'zod';
import { hasValidPlanHash } from './hash.js';
import {
  compareDecimalStrings,
  compareUtcTimestamps,
  nonNegativeDecimalSchema,
  positiveDecimalSchema,
  sha256DigestSchema,
  stableIdSchema,
  utcTimestampSchema,
} from './primitives.js';
import {
  orderAttemptSchema,
  sideSchema,
  symbolSchema,
  tradePlanSchema,
  venueStatusSchema,
  verificationResultSchema,
  type TradePlan,
  type VerificationChecks,
  type VerificationResult,
} from './schemas.js';

const authorizationRecordSchema = z
  .object({
    planId: stableIdSchema,
    ownerId: stableIdSchema,
    planHash: sha256DigestSchema,
    approvedAtUtc: utcTimestampSchema,
  })
  .strict();

export const persistentPaperOrderSchema = z
  .object({
    orderId: stableIdSchema,
    planId: stableIdSchema,
    clientOrderId: stableIdSchema,
    symbol: symbolSchema,
    side: sideSchema,
    quantity: positiveDecimalSchema,
    limitPrice: positiveDecimalSchema,
    status: venueStatusSchema,
    filledQuantity: nonNegativeDecimalSchema,
    createdAtUtc: utcTimestampSchema,
    updatedAtUtc: utcTimestampSchema,
    requestDigest: sha256DigestSchema,
  })
  .strict()
  .superRefine((order, context) => {
    if (compareUtcTimestamps(order.updatedAtUtc, order.createdAtUtc) < 0) {
      context.addIssue({
        code: 'custom',
        path: ['updatedAtUtc'],
        message: 'Order update cannot predate creation',
      });
    }
    const hasFill = compareDecimalStrings(order.filledQuantity, '0') > 0;
    if (
      (order.status === 'PARTIALLY_FILLED' || order.status === 'FILLED') &&
      !hasFill
    ) {
      context.addIssue({
        code: 'custom',
        path: ['filledQuantity'],
        message: `${order.status} has an inconsistent filled quantity`,
      });
    }
    if (
      (order.status === 'NEW' ||
        order.status === 'REJECTED' ||
        order.status === 'EXPIRED') &&
      hasFill
    ) {
      context.addIssue({
        code: 'custom',
        path: ['filledQuantity'],
        message: `${order.status} cannot report a filled quantity`,
      });
    }
  });

const planEvidenceSchema = z
  .object({ evidenceId: stableIdSchema, data: tradePlanSchema })
  .strict();
const authorizationEvidenceSchema = z
  .object({ evidenceId: stableIdSchema, data: authorizationRecordSchema })
  .strict();
const attemptsEvidenceSchema = z
  .object({ evidenceId: stableIdSchema, data: z.array(orderAttemptSchema) })
  .strict();
const orderEvidenceSchema = z
  .object({ evidenceId: stableIdSchema, data: persistentPaperOrderSchema })
  .strict();

/** Undefined evidence means the durable read was unavailable, not that it passed. */
export const verificationEvidenceSnapshotSchema = z
  .object({
    plan: planEvidenceSchema.optional(),
    authorization: authorizationEvidenceSchema.optional(),
    attempts: attemptsEvidenceSchema.optional(),
    order: orderEvidenceSchema.optional(),
  })
  .strict();

export type VerificationEvidenceSnapshot = z.infer<
  typeof verificationEvidenceSnapshotSchema
>;
export type PersistentPaperOrder = z.infer<typeof persistentPaperOrderSchema>;

export interface VerificationEvidenceReader {
  loadVerificationEvidence(planId: string): Promise<unknown>;
}

const failedChecks = (): VerificationChecks => ({
  PLAN_HASH_MATCHES: false,
  PLAN_APPROVED: false,
  OWNER_AUTHORIZATION_MATCHES: false,
  PLAN_NOT_EXPIRED_AT_SUBMISSION: false,
  ORDER_ATTEMPT_UNIQUE: false,
  ORDER_REQUEST_MATCHES_PLAN: false,
  EXECUTION_STATUS_MATCHES: false,
  CANCELLATION_STATE_MATCHES: false,
  PAPER_EVIDENCE_ONLY: false,
});

export function digestPersistentPaperOrderRequest(
  order: Pick<
    PersistentPaperOrder,
    'clientOrderId' | 'planId' | 'symbol' | 'side' | 'quantity' | 'limitPrice'
  >,
  planHash: string,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        clientOrderId: order.clientOrderId,
        planId: order.planId,
        symbol: order.symbol,
        side: order.side,
        quantity: order.quantity,
        limitPrice: order.limitPrice,
        planHash,
      }),
      'utf8',
    )
    .digest('hex');
}

function multiplyDecimalStrings(left: string, right: string): string {
  const [leftWhole = '', leftFraction = ''] = left.split('.');
  const [rightWhole = '', rightFraction = ''] = right.split('.');
  const coefficient =
    BigInt(`${leftWhole}${leftFraction}`) *
    BigInt(`${rightWhole}${rightFraction}`);
  const scale = leftFraction.length + rightFraction.length;
  if (scale === 0) return coefficient.toString();
  const digits = coefficient.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function requestMatchesPlan(
  plan: TradePlan,
  order: PersistentPaperOrder,
): boolean {
  if (
    order.planId !== plan.id ||
    order.symbol !== plan.symbol ||
    order.side !== plan.side ||
    order.requestDigest !==
      digestPersistentPaperOrderRequest(order, plan.planHash)
  ) {
    return false;
  }
  const priceComparison = compareDecimalStrings(
    order.limitPrice,
    plan.limitPrice,
  );
  if (plan.side === 'BUY') {
    return (
      priceComparison <= 0 &&
      plan.quoteBudgetUsdt !== undefined &&
      compareDecimalStrings(
        multiplyDecimalStrings(order.quantity, order.limitPrice),
        plan.quoteBudgetUsdt,
      ) <= 0
    );
  }
  return (
    priceComparison >= 0 &&
    plan.baseQuantityBtc !== undefined &&
    compareDecimalStrings(order.quantity, plan.baseQuantityBtc) === 0
  );
}

function cancellationMatches(
  state: TradePlan['state'],
  status: PersistentPaperOrder['status'],
): boolean {
  if (state === 'CANCELLED') return status === 'CANCELED';
  if (status === 'CANCELED') return false;
  return true;
}

function planExecutionStatusMatches(
  state: TradePlan['state'],
  status: PersistentPaperOrder['status'],
): boolean {
  switch (state) {
    case 'SUBMITTING':
    case 'UNCERTAIN':
      return true;
    case 'OPEN':
      return status === 'NEW';
    case 'PARTIALLY_FILLED':
      return status === 'PARTIALLY_FILLED';
    case 'FILLED':
      return status === 'FILLED';
    case 'REJECTED':
      return status === 'REJECTED';
    case 'CANCEL_REQUESTED':
      return (
        status === 'NEW' ||
        status === 'PARTIALLY_FILLED' ||
        status === 'FILLED' ||
        status === 'CANCELED'
      );
    case 'CANCELLED':
      return status === 'CANCELED';
    case 'EXPIRED':
      return status === 'EXPIRED';
    default:
      return false;
  }
}

export function verifyPersistentRecords(
  snapshotInput: unknown,
): VerificationResult {
  const parsed = verificationEvidenceSnapshotSchema.safeParse(snapshotInput);
  if (!parsed.success) {
    return verificationResultSchema.parse({
      result: 'UNCERTAIN',
      checks: failedChecks(),
      evidenceIds: [],
    });
  }
  const snapshot = parsed.data;
  const evidenceIds = [
    snapshot.plan?.evidenceId,
    snapshot.authorization?.evidenceId,
    snapshot.attempts?.evidenceId,
    snapshot.order?.evidenceId,
  ].filter((value): value is string => value !== undefined);
  const uniqueEvidenceIds = [...new Set(evidenceIds)];
  const plan = snapshot.plan?.data;
  const authorization = snapshot.authorization?.data;
  const attempts = snapshot.attempts?.data;
  const order = snapshot.order?.data;
  const attempt = attempts?.length === 1 ? attempts[0] : undefined;

  const checks: VerificationChecks = {
    PLAN_HASH_MATCHES: plan !== undefined && hasValidPlanHash(plan),
    PLAN_APPROVED: plan?.approvedAtUtc !== undefined,
    OWNER_AUTHORIZATION_MATCHES:
      plan !== undefined &&
      authorization !== undefined &&
      authorization.planId === plan.id &&
      authorization.ownerId === plan.ownerId &&
      authorization.planHash === plan.planHash &&
      authorization.approvedAtUtc === plan.approvedAtUtc,
    PLAN_NOT_EXPIRED_AT_SUBMISSION:
      plan?.approvedAtUtc !== undefined &&
      order !== undefined &&
      compareUtcTimestamps(order.createdAtUtc, plan.approvedAtUtc) >= 0 &&
      compareUtcTimestamps(order.createdAtUtc, plan.expiresAtUtc) < 0,
    ORDER_ATTEMPT_UNIQUE: attempts?.length === 1,
    ORDER_REQUEST_MATCHES_PLAN:
      plan !== undefined &&
      order !== undefined &&
      attempt !== undefined &&
      requestMatchesPlan(plan, order) &&
      attempt.planId === order.planId &&
      attempt.clientOrderId === order.clientOrderId &&
      attempt.requestDigest === order.requestDigest,
    EXECUTION_STATUS_MATCHES:
      plan !== undefined &&
      attempt !== undefined &&
      order !== undefined &&
      attempt.remoteOrderId === order.orderId &&
      attempt.venueStatus === order.status &&
      planExecutionStatusMatches(plan.state, order.status),
    CANCELLATION_STATE_MATCHES:
      plan !== undefined &&
      order !== undefined &&
      cancellationMatches(plan.state, order.status),
    PAPER_EVIDENCE_ONLY:
      plan?.mode === 'PAPER' &&
      attempts !== undefined &&
      attempts.length > 0 &&
      attempts.every(
        (candidate) => candidate.evidenceSource === 'ORIGINAL_PAPER',
      ),
  };
  const complete =
    plan !== undefined &&
    authorization !== undefined &&
    attempts !== undefined &&
    order !== undefined;
  const allPassed = Object.values(checks).every(Boolean);

  return verificationResultSchema.parse({
    result: !complete ? 'UNCERTAIN' : allPassed ? 'VERIFIED' : 'BLOCKED',
    checks,
    evidenceIds: uniqueEvidenceIds,
  });
}

/** Independent, read-only adapter: no model-provided check names are accepted. */
export class PersistentRecordsVerifierAdapter {
  constructor(private readonly reader: VerificationEvidenceReader) {}

  async verify(planId: string): Promise<VerificationResult> {
    try {
      return verifyPersistentRecords(
        await this.reader.loadVerificationEvidence(planId),
      );
    } catch {
      return verificationResultSchema.parse({
        result: 'UNCERTAIN',
        checks: failedChecks(),
        evidenceIds: [],
      });
    }
  }
}
