import { createHash, timingSafeEqual } from "node:crypto";
import type { ImmutableTradeInstruction, TradePlan } from "./schemas.js";
import { sha256DigestSchema } from "./primitives.js";
import { immutableTradeInstructionSchema, tradePlanSchema } from "./schemas.js";

const IMMUTABLE_KEYS = [
  "id",
  "ownerId",
  "symbol",
  "side",
  "quoteBudgetUsdt",
  "baseQuantityBtc",
  "triggerPrice",
  "triggerOperator",
  "limitPrice",
  "expiresAtUtc",
  "timezone",
  "mode",
] as const satisfies readonly (keyof ImmutableTradeInstruction)[];

/** Return immutable authorization fields in a fixed, documented key order. */
export function immutableInstructionFromPlan(
  plan: ImmutableTradeInstruction | TradePlan,
): ImmutableTradeInstruction {
  const candidate: Record<string, unknown> = {};
  for (const key of IMMUTABLE_KEYS) {
    const value = plan[key];
    if (value !== undefined) candidate[key] = value;
  }
  return immutableTradeInstructionSchema.parse(candidate);
}

/** JSON serialization used as the stable preimage for plan authorization. */
export function canonicalizeTradeInstruction(
  instruction: ImmutableTradeInstruction | TradePlan,
): string {
  return JSON.stringify(immutableInstructionFromPlan(instruction));
}

export function hashTradeInstruction(
  instruction: ImmutableTradeInstruction | TradePlan,
): string {
  return createHash("sha256").update(canonicalizeTradeInstruction(instruction), "utf8").digest("hex");
}

/** Timing-safe check that the stored approval still matches the immutable instruction. */
export function hasValidPlanHash(plan: TradePlan): boolean {
  const parsedPlan = tradePlanSchema.parse(plan);
  const expected = Buffer.from(hashTradeInstruction(parsedPlan), "hex");
  const actual = Buffer.from(sha256DigestSchema.parse(parsedPlan.planHash), "hex");
  return timingSafeEqual(expected, actual);
}
