import type { PlanState, TradePlan } from "./schemas.js";
import { hasValidPlanHash, immutableInstructionFromPlan } from "./hash.js";
import { tradePlanSchema } from "./schemas.js";

export const allowedPlanTransitions: Readonly<Record<PlanState, readonly PlanState[]>> = {
  DRAFT: ["AWAITING_CONFIRMATION"],
  AWAITING_CONFIRMATION: ["DRAFT", "ARMED"],
  ARMED: ["TRIGGERED", "CANCELLED", "EXPIRED"],
  TRIGGERED: ["SUBMITTING", "CANCELLED", "EXPIRED", "NEEDS_HUMAN"],
  SUBMITTING: ["OPEN", "PARTIALLY_FILLED", "FILLED", "REJECTED", "UNCERTAIN"],
  OPEN: ["PARTIALLY_FILLED", "FILLED", "CANCEL_REQUESTED", "REJECTED", "UNCERTAIN"],
  PARTIALLY_FILLED: ["FILLED", "CANCEL_REQUESTED", "UNCERTAIN"],
  FILLED: [],
  REJECTED: [],
  UNCERTAIN: ["OPEN", "PARTIALLY_FILLED", "FILLED", "REJECTED", "CANCELLED", "NEEDS_HUMAN"],
  CANCEL_REQUESTED: ["OPEN", "PARTIALLY_FILLED", "FILLED", "CANCELLED", "UNCERTAIN", "NEEDS_HUMAN"],
  CANCELLED: [],
  EXPIRED: [],
  NEEDS_HUMAN: [],
};

export class InvalidPlanTransitionError extends Error {
  override readonly name = "InvalidPlanTransitionError";
}

export function isPlanTransitionAllowed(from: PlanState, to: PlanState): boolean {
  return allowedPlanTransitions[from].includes(to);
}

function immutableFieldsMatch(previous: TradePlan, next: TradePlan): boolean {
  return JSON.stringify(immutableInstructionFromPlan(previous)) === JSON.stringify(immutableInstructionFromPlan(next));
}

/**
 * Validate a persisted state change, including optimistic revision, immutable
 * authorization fields, and approval-digest integrity.
 */
export function validatePlanTransition(previousInput: TradePlan, nextInput: TradePlan): TradePlan {
  const previous = tradePlanSchema.parse(previousInput);
  const next = tradePlanSchema.parse(nextInput);

  if (!isPlanTransitionAllowed(previous.state, next.state)) {
    throw new InvalidPlanTransitionError(`Transition ${previous.state} -> ${next.state} is not allowed`);
  }
  if (next.revision !== previous.revision + 1) {
    throw new InvalidPlanTransitionError(
      `Revision must advance exactly once (expected ${previous.revision + 1}, received ${next.revision})`,
    );
  }
  const freezesAuthorization = next.state === "ARMED" || previous.approvedAtUtc !== undefined;
  if (freezesAuthorization && !immutableFieldsMatch(previous, next)) {
    throw new InvalidPlanTransitionError("Immutable trade instructions cannot change during or after approval");
  }
  if (freezesAuthorization && previous.planHash !== next.planHash) {
    throw new InvalidPlanTransitionError("The approval digest cannot change during or after approval");
  }
  if ((previous.approvedAtUtc ?? null) !== (next.approvedAtUtc ?? null) && next.state !== "ARMED") {
    throw new InvalidPlanTransitionError("Approval time can only be added when arming a plan");
  }
  if (!hasValidPlanHash(next)) {
    throw new InvalidPlanTransitionError("The plan digest does not match the immutable trade instruction");
  }

  return next;
}
