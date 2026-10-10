import { timingSafeEqual } from 'node:crypto';
import {
  canonicalizeInstructionFields,
  digestInstructionFields,
  immutableInstructionKeys,
} from './canonical.js';
import type { ImmutableTradeInstruction, TradePlan } from './schemas.js';
import { sha256DigestSchema } from './primitives.js';
import { immutableTradeInstructionSchema } from './schemas.js';

/** Return immutable authorization fields in a fixed, documented key order. */
export function immutableInstructionFromPlan(
  plan: ImmutableTradeInstruction | TradePlan,
): ImmutableTradeInstruction {
  const candidate: Record<string, unknown> = {};
  for (const key of immutableInstructionKeys) {
    const value = plan[key];
    if (value !== undefined) candidate[key] = value;
  }
  return immutableTradeInstructionSchema.parse(candidate);
}

/** JSON serialization used as the stable preimage for plan authorization. */
export function canonicalizeTradeInstruction(
  instruction: ImmutableTradeInstruction | TradePlan,
): string {
  return canonicalizeInstructionFields(
    immutableInstructionFromPlan(instruction),
  );
}

export function hashTradeInstruction(
  instruction: ImmutableTradeInstruction | TradePlan,
): string {
  return digestInstructionFields(immutableInstructionFromPlan(instruction));
}

/** Timing-safe check that the stored approval still matches the immutable instruction. */
export function hasValidPlanHash(plan: TradePlan): boolean {
  try {
    const expected = Buffer.from(hashTradeInstruction(plan), 'hex');
    const actual = Buffer.from(sha256DigestSchema.parse(plan.planHash), 'hex');
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
