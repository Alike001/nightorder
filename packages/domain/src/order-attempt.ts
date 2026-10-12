import { z } from 'zod';
import {
  evidenceSourceSchema,
  orderAttemptSchema,
  orderAttemptStateSchema,
  venueStatusSchema,
  type OrderAttempt,
} from './schemas.js';
import {
  sha256DigestSchema,
  stableIdSchema,
  utcTimestampSchema,
} from './primitives.js';

/** Exact persisted projection currently exposed by SQLite PaperOrderAttempt. */
export const sqlitePaperOrderAttemptSchema = z
  .object({
    id: stableIdSchema,
    planId: stableIdSchema,
    operationId: stableIdSchema,
    clientOrderId: stableIdSchema,
    requestDigest: sha256DigestSchema,
    state: orderAttemptStateSchema,
    venueStatus: venueStatusSchema.optional(),
    evidenceSource: evidenceSourceSchema,
    createdAtUtc: utcTimestampSchema,
    orderId: stableIdSchema.optional(),
    reconciledAtUtc: utcTimestampSchema.optional(),
  })
  .strict();

export type SqlitePaperOrderAttempt = z.infer<
  typeof sqlitePaperOrderAttemptSchema
>;

/**
 * Map SQLite names to the canonical journal without manufacturing evidence.
 * `orderId` is the paper adapter's name for canonical `remoteOrderId`.
 * Optional status, order ID, and reconciliation time stay absent when the row
 * does not contain them; the canonical schema then enforces state invariants.
 */
export function mapSqlitePaperOrderAttempt(input: unknown): OrderAttempt {
  const row = sqlitePaperOrderAttemptSchema.parse(input);
  return orderAttemptSchema.parse({
    id: row.id,
    planId: row.planId,
    operationId: row.operationId,
    clientOrderId: row.clientOrderId,
    requestDigest: row.requestDigest,
    ...(row.orderId === undefined ? {} : { remoteOrderId: row.orderId }),
    state: row.state,
    ...(row.venueStatus === undefined ? {} : { venueStatus: row.venueStatus }),
    evidenceSource: row.evidenceSource,
    createdAtUtc: row.createdAtUtc,
    ...(row.reconciledAtUtc === undefined
      ? {}
      : { reconciledAtUtc: row.reconciledAtUtc }),
  });
}
