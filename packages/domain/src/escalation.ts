import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  planStateSchema,
  toolResultSchema,
  type PlanState,
  type ToolResult,
} from './schemas.js';
import { stableIdSchema, utcTimestampSchema } from './primitives.js';

export const needsHumanReasonCodeSchema = z.enum([
  'MODEL_UNAVAILABLE',
  'TRACING_UNAVAILABLE',
  'MODEL_TOOL_PROTOCOL_FAILURE',
  'VERIFICATION_BLOCKED',
  'RECOVERY_UNCERTAIN',
  'OBSERVATION_WRITE_FAILED',
]);

export function needsHumanIdempotencyKey(
  planId: string,
  reasonCode: NeedsHumanReasonCode,
): string {
  return createHash('sha256')
    .update(`${planId}\0${reasonCode}`, 'utf8')
    .digest('hex');
}

export const needsHumanEscalationSchema = z
  .object({
    id: stableIdSchema,
    planId: stableIdSchema,
    reasonCode: needsHumanReasonCodeSchema,
    idempotencyKey: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.literal('OPEN'),
    planStateAtEscalation: planStateSchema,
    planRevisionAtEscalation: z.number().int().nonnegative(),
    createdAtUtc: utcTimestampSchema,
  })
  .strict()
  .superRefine((escalation, context) => {
    if (
      escalation.idempotencyKey !==
      needsHumanIdempotencyKey(escalation.planId, escalation.reasonCode)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['idempotencyKey'],
        message: 'Escalation idempotency key does not match plan and reason',
      });
    }
  });

export const markNeedsHumanResultSchema = toolResultSchema(
  needsHumanEscalationSchema,
);

export type NeedsHumanReasonCode = z.infer<typeof needsHumanReasonCodeSchema>;
export type NeedsHumanEscalation = z.infer<typeof needsHumanEscalationSchema>;

export class StalePlanRevisionError extends Error {
  override readonly name = 'StalePlanRevisionError';
}

/**
 * Enforce the compare-and-set precondition used inside an escalation write
 * transaction. The record captures, but never replaces, the plan's order state.
 */
export function assertEscalationRevision(
  currentRevision: number,
  expectedRevision: number,
): void {
  if (currentRevision !== expectedRevision) {
    throw new StalePlanRevisionError(
      `Stale plan revision (expected ${expectedRevision}, found ${currentRevision})`,
    );
  }
}

export const potentiallyActivePlanStates: ReadonlySet<PlanState> = new Set([
  'SUBMITTING',
  'OPEN',
  'PARTIALLY_FILLED',
  'UNCERTAIN',
  'CANCEL_REQUESTED',
]);

/**
 * Durable escalation repository contract.
 *
 * Implementations MUST use one transaction to read the plan revision, perform
 * a compare-and-set check, and insert the escalation. `(planId, reasonCode)` is
 * the idempotency key: a retry returns the original record/evidence ID. A
 * revision race returns STALE_REVISION and a failed durable write returns
 * PERSISTENCE_FAILED. Implementations MUST NOT mutate a potentially-active plan
 * to NEEDS_HUMAN; its execution/cancellation state remains visible while this
 * orthogonal escalation record is open.
 */
export interface NeedsHumanEscalationRepository {
  markNeedsHuman(
    planId: string,
    reasonCode: NeedsHumanReasonCode,
  ): Promise<ToolResult<NeedsHumanEscalation>>;
}
