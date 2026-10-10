import { z } from 'zod';
import { digestInstructionFields } from './canonical.js';
import {
  compareDecimalStrings,
  compareUtcTimestamps,
  ianaTimezoneSchema,
  nonNegativeDecimalSchema,
  positiveDecimalSchema,
  sha256DigestSchema,
  stableIdSchema,
  utcTimestampSchema,
} from './primitives.js';

export const symbolSchema = z.literal('BTCUSDT');
export const modeSchema = z.literal('PAPER');
export const sideSchema = z.enum(['BUY', 'SELL']);
export const triggerOperatorSchema = z.enum(['ASK_LTE', 'BID_GTE']);
export const planStateSchema = z.enum([
  'DRAFT',
  'AWAITING_CONFIRMATION',
  'ARMED',
  'TRIGGERED',
  'SUBMITTING',
  'OPEN',
  'PARTIALLY_FILLED',
  'FILLED',
  'REJECTED',
  'UNCERTAIN',
  'CANCEL_REQUESTED',
  'CANCELLED',
  'EXPIRED',
  'NEEDS_HUMAN',
]);

export const immutableTradeInstructionSchema = z
  .object({
    id: stableIdSchema,
    ownerId: stableIdSchema,
    symbol: symbolSchema,
    side: sideSchema,
    quoteBudgetUsdt: positiveDecimalSchema.optional(),
    baseQuantityBtc: positiveDecimalSchema.optional(),
    triggerPrice: positiveDecimalSchema,
    triggerOperator: triggerOperatorSchema,
    limitPrice: positiveDecimalSchema,
    expiresAtUtc: utcTimestampSchema,
    timezone: ianaTimezoneSchema,
    mode: modeSchema,
  })
  .strict()
  .superRefine((instruction, context) => {
    if (instruction.side === 'BUY') {
      if (instruction.quoteBudgetUsdt === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['quoteBudgetUsdt'],
          message: 'BUY requires a quote budget',
        });
      }
      if (instruction.baseQuantityBtc !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['baseQuantityBtc'],
          message: 'BUY must not set a base quantity',
        });
      }
      if (instruction.triggerOperator !== 'ASK_LTE') {
        context.addIssue({
          code: 'custom',
          path: ['triggerOperator'],
          message: 'BUY requires ASK_LTE',
        });
      }
    } else {
      if (instruction.baseQuantityBtc === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['baseQuantityBtc'],
          message: 'SELL requires a base quantity',
        });
      }
      if (instruction.quoteBudgetUsdt !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['quoteBudgetUsdt'],
          message: 'SELL must not set a quote budget',
        });
      }
      if (instruction.triggerOperator !== 'BID_GTE') {
        context.addIssue({
          code: 'custom',
          path: ['triggerOperator'],
          message: 'SELL requires BID_GTE',
        });
      }
    }
  });

const approvedStates = new Set([
  'ARMED',
  'TRIGGERED',
  'SUBMITTING',
  'OPEN',
  'PARTIALLY_FILLED',
  'FILLED',
  'REJECTED',
  'UNCERTAIN',
  'CANCEL_REQUESTED',
  'CANCELLED',
  'EXPIRED',
  'NEEDS_HUMAN',
]);

export const tradePlanSchema = immutableTradeInstructionSchema
  .safeExtend({
    planHash: sha256DigestSchema,
    approvedAtUtc: utcTimestampSchema.optional(),
    state: planStateSchema,
    revision: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((plan, context) => {
    const needsApproval = approvedStates.has(plan.state);
    if (needsApproval && plan.approvedAtUtc === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['approvedAtUtc'],
        message: `${plan.state} requires approval`,
      });
    }
    if (!needsApproval && plan.approvedAtUtc !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['approvedAtUtc'],
        message: `${plan.state} must not be approved`,
      });
    }
    if (
      plan.approvedAtUtc !== undefined &&
      compareUtcTimestamps(plan.approvedAtUtc, plan.expiresAtUtc) >= 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['approvedAtUtc'],
        message: 'Approval must precede expiry',
      });
    }
    if (digestInstructionFields(plan) !== plan.planHash) {
      context.addIssue({
        code: 'custom',
        path: ['planHash'],
        message: 'Plan digest does not match the immutable trade instruction',
      });
    }
  });

export const quoteKindSchema = z.enum(['LIVE_PUBLIC', 'TEST_FIXTURE']);
export const marketQuoteSchema = z
  .object({
    symbol: symbolSchema,
    bestBid: positiveDecimalSchema,
    bestAsk: positiveDecimalSchema,
    observedAtUtc: utcTimestampSchema,
    receivedAtUtc: utcTimestampSchema,
    source: z.string().trim().min(1).max(200),
    kind: quoteKindSchema,
  })
  .strict()
  .superRefine((quote, context) => {
    if (compareDecimalStrings(quote.bestBid, quote.bestAsk) > 0) {
      context.addIssue({
        code: 'custom',
        path: ['bestAsk'],
        message: 'Best ask must be at least best bid',
      });
    }
    if (compareUtcTimestamps(quote.observedAtUtc, quote.receivedAtUtc) > 0) {
      context.addIssue({
        code: 'custom',
        path: ['receivedAtUtc'],
        message: 'Quote cannot be received before observation',
      });
    }
  });

export const orderAttemptStateSchema = z.enum([
  'PREPARED',
  'SENDING',
  'UNCERTAIN',
  'ACKNOWLEDGED',
  'RECONCILED',
]);
export const venueStatusSchema = z.enum([
  'NEW',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
]);
export const acceptedVenueStatusSchema = z.enum([
  'NEW',
  'PARTIALLY_FILLED',
  'FILLED',
]);
export const submitApprovedOrderInputSchema = z
  .object({
    clientOrderId: stableIdSchema,
    planId: stableIdSchema,
    symbol: symbolSchema,
    side: sideSchema,
    quantity: positiveDecimalSchema,
    limitPrice: positiveDecimalSchema,
  })
  .strict();
export const orderStatusResultSchema = z
  .object({ orderId: stableIdSchema, status: acceptedVenueStatusSchema })
  .strict();
export const orderReadbackResultSchema = z
  .object({
    orderId: stableIdSchema,
    status: venueStatusSchema,
    filledQuantity: nonNegativeDecimalSchema,
  })
  .strict()
  .superRefine((readback, context) => {
    if (
      (readback.status === 'PARTIALLY_FILLED' ||
        readback.status === 'FILLED') &&
      compareDecimalStrings(readback.filledQuantity, '0') === 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['filledQuantity'],
        message: `${readback.status} requires a positive filled quantity`,
      });
    }
    if (
      (readback.status === 'NEW' ||
        readback.status === 'REJECTED' ||
        readback.status === 'EXPIRED') &&
      compareDecimalStrings(readback.filledQuantity, '0') !== 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['filledQuantity'],
        message: `${readback.status} cannot report a filled quantity`,
      });
    }
  });
export const cancelRequestResultSchema = z
  .object({ status: z.literal('CANCEL_REQUESTED') })
  .strict();
export const evidenceSourceSchema = z.literal('ORIGINAL_PAPER');
export const orderAttemptSchema = z
  .object({
    id: stableIdSchema,
    planId: stableIdSchema,
    operationId: stableIdSchema,
    clientOrderId: stableIdSchema,
    requestDigest: sha256DigestSchema,
    remoteOrderId: stableIdSchema.optional(),
    state: orderAttemptStateSchema,
    venueStatus: venueStatusSchema.optional(),
    evidenceSource: evidenceSourceSchema,
    createdAtUtc: utcTimestampSchema,
    reconciledAtUtc: utcTimestampSchema.optional(),
  })
  .strict()
  .superRefine((attempt, context) => {
    const hasRemoteEvidence =
      attempt.remoteOrderId !== undefined && attempt.venueStatus !== undefined;
    if (
      (attempt.state === 'PREPARED' ||
        attempt.state === 'SENDING' ||
        attempt.state === 'UNCERTAIN') &&
      attempt.venueStatus !== undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['venueStatus'],
        message: `${attempt.state} cannot claim a known venue status`,
      });
    }
    if (
      (attempt.state === 'PREPARED' || attempt.state === 'SENDING') &&
      attempt.remoteOrderId !== undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['remoteOrderId'],
        message: `${attempt.state} cannot claim a remote order ID`,
      });
    }
    if (
      (attempt.state === 'ACKNOWLEDGED' || attempt.state === 'RECONCILED') &&
      !hasRemoteEvidence
    ) {
      context.addIssue({
        code: 'custom',
        path: ['venueStatus'],
        message: `${attempt.state} requires a remote order ID and venue status`,
      });
    }
    if (
      attempt.state === 'RECONCILED' &&
      attempt.reconciledAtUtc === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['reconciledAtUtc'],
        message: 'RECONCILED requires a timestamp',
      });
    }
    if (
      attempt.state !== 'RECONCILED' &&
      attempt.reconciledAtUtc !== undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['reconciledAtUtc'],
        message: 'Only RECONCILED may have a reconciliation timestamp',
      });
    }
    if (
      attempt.reconciledAtUtc !== undefined &&
      compareUtcTimestamps(attempt.reconciledAtUtc, attempt.createdAtUtc) < 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['reconciledAtUtc'],
        message: 'Reconciliation cannot predate creation',
      });
    }
  });

export const toolErrorCodeSchema = z.enum([
  'STALE_QUOTE',
  'EXPIRED',
  'UNAUTHORIZED',
  'INSUFFICIENT_BALANCE',
  'REJECTED',
  'TIMEOUT',
  'RATE_LIMIT',
  'NETWORK',
  'NOT_FOUND',
  'AMBIGUOUS',
]);

export function toolResultSchema<T extends z.ZodType>(dataSchema: T) {
  return z.discriminatedUnion('ok', [
    z
      .object({
        ok: z.literal(true),
        data: dataSchema,
        evidenceId: stableIdSchema,
      })
      .strict(),
    z
      .object({
        ok: z.literal(false),
        code: toolErrorCodeSchema,
        message: z.string().trim().min(1),
        retrySafe: z.boolean(),
        evidenceId: stableIdSchema,
      })
      .strict(),
  ]);
}

export const submitApprovedOrderResultSchema = toolResultSchema(
  orderStatusResultSchema,
);
export const orderReadbackToolResultSchema = toolResultSchema(
  orderReadbackResultSchema,
);
export const cancelRequestToolResultSchema = toolResultSchema(
  cancelRequestResultSchema,
);

export const verificationCheckSchema = z.enum([
  'PLAN_HASH_MATCHES',
  'PLAN_APPROVED',
  'OWNER_AUTHORIZATION_MATCHES',
  'PLAN_NOT_EXPIRED_AT_SUBMISSION',
  'ORDER_ATTEMPT_UNIQUE',
  'ORDER_REQUEST_MATCHES_PLAN',
  'EXECUTION_STATUS_MATCHES',
  'CANCELLATION_STATE_MATCHES',
  'PAPER_EVIDENCE_ONLY',
]);
export const verificationChecksSchema = z.record(
  verificationCheckSchema,
  z.boolean(),
);
const evidenceReferencesSchema = z
  .array(stableIdSchema)
  .min(1, 'At least one evidence reference is required')
  .superRefine((evidenceIds, context) => {
    if (new Set(evidenceIds).size !== evidenceIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Evidence references must be unique',
      });
    }
  });

export const verificationResultSchema = z
  .object({
    result: z.enum(['VERIFIED', 'BLOCKED', 'UNCERTAIN']),
    checks: verificationChecksSchema,
    evidenceIds: evidenceReferencesSchema,
  })
  .strict()
  .superRefine((verification, context) => {
    const allChecksPass = Object.values(verification.checks).every(Boolean);
    if (verification.result === 'VERIFIED' && !allChecksPass) {
      context.addIssue({
        code: 'custom',
        path: ['checks'],
        message: 'VERIFIED requires every verification check to pass',
      });
    }
    if (verification.result !== 'VERIFIED' && allChecksPass) {
      context.addIssue({
        code: 'custom',
        path: ['result'],
        message:
          'A non-verified result requires at least one failed or unresolved check',
      });
    }
  });

export type Symbol = z.infer<typeof symbolSchema>;
export type Mode = z.infer<typeof modeSchema>;
export type Side = z.infer<typeof sideSchema>;
export type TriggerOperator = z.infer<typeof triggerOperatorSchema>;
export type PlanState = z.infer<typeof planStateSchema>;
export type ImmutableTradeInstruction = z.infer<
  typeof immutableTradeInstructionSchema
>;
export type TradePlan = z.infer<typeof tradePlanSchema>;
export type QuoteKind = z.infer<typeof quoteKindSchema>;
export type MarketQuote = z.infer<typeof marketQuoteSchema>;
export type OrderAttemptState = z.infer<typeof orderAttemptStateSchema>;
export type VenueStatus = z.infer<typeof venueStatusSchema>;
export type AcceptedVenueStatus = z.infer<typeof acceptedVenueStatusSchema>;
export type SubmitApprovedOrderInput = z.infer<
  typeof submitApprovedOrderInputSchema
>;
export type OrderStatusResult = z.infer<typeof orderStatusResultSchema>;
export type OrderReadbackResult = z.infer<typeof orderReadbackResultSchema>;
export type CancelRequestResult = z.infer<typeof cancelRequestResultSchema>;
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;
export type OrderAttempt = z.infer<typeof orderAttemptSchema>;
export type ToolErrorCode = z.infer<typeof toolErrorCodeSchema>;
export type ToolResult<T> =
  | { ok: true; data: T; evidenceId: string }
  | {
      ok: false;
      code: ToolErrorCode;
      message: string;
      retrySafe: boolean;
      evidenceId: string;
    };
export type VerificationResult = z.infer<typeof verificationResultSchema>;
export type VerificationCheck = z.infer<typeof verificationCheckSchema>;
export type VerificationChecks = z.infer<typeof verificationChecksSchema>;
export type VirtualBalances = Record<'BTC' | 'USDT', string>;

export const virtualBalancesSchema = z
  .object({ BTC: nonNegativeDecimalSchema, USDT: nonNegativeDecimalSchema })
  .strict();
