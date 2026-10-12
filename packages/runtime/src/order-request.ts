import { digestPersistentPaperOrderRequest } from '@nightorder/domain';
import type { SubmitApprovedOrderInput, TradePlan } from '@nightorder/domain';

function decimalParts(value: string): { coefficient: bigint; scale: number } {
  const [whole = '', fraction = ''] = value.split('.');
  return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function buyQuantityAtLimit(plan: TradePlan): string {
  if (!plan.quoteBudgetUsdt) throw new Error('BUY plan has no quote budget.');
  const budget = decimalParts(plan.quoteBudgetUsdt);
  const price = decimalParts(plan.limitPrice);
  const scale = 8;
  const quantityUnits =
    (budget.coefficient * 10n ** BigInt(price.scale + scale)) /
    (price.coefficient * 10n ** BigInt(budget.scale));
  if (quantityUnits <= 0n) {
    throw new Error('Approved quote budget is below one BTC quantity unit.');
  }
  const digits = quantityUnits.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Build the exact bounded request used by both the atomic claim and PAPER port. */
export function buildPaperOrderRequest(
  plan: TradePlan,
  clientOrderId = `nightorder-${plan.id}`,
): SubmitApprovedOrderInput {
  return {
    clientOrderId,
    planId: plan.id,
    symbol: plan.symbol,
    side: plan.side,
    quantity:
      plan.side === 'BUY' ? buyQuantityAtLimit(plan) : plan.baseQuantityBtc!,
    limitPrice: plan.limitPrice,
  };
}

export function requestDigestForPlan(plan: TradePlan): string {
  const request = buildPaperOrderRequest(plan);
  return digestPersistentPaperOrderRequest(request, plan.planHash);
}
