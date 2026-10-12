import {
  compareUtcTimestamps,
  type OrderAttempt,
  type TradePlan,
} from '@nightorder/domain';

export function formatPlanPreview(plan: TradePlan): string {
  const amount =
    plan.side === 'BUY'
      ? `${plan.quoteBudgetUsdt ?? 'INVALID'} USDT maximum budget`
      : `${plan.baseQuantityBtc ?? 'INVALID'} BTC quantity`;
  const condition =
    plan.triggerOperator === 'ASK_LTE'
      ? `best executable ask <= ${plan.triggerPrice} USDT/BTC`
      : `best executable bid >= ${plan.triggerPrice} USDT/BTC`;

  return [
    'PAPER ONLY — exact plan preview',
    `Plan: ${plan.id}`,
    `Owner: ${plan.ownerId}`,
    `Market: BTC/USDT spot`,
    `Direction: ${plan.side}`,
    `Amount: ${amount}`,
    `Condition: ${condition}`,
    `Worst execution limit: ${plan.limitPrice} USDT/BTC`,
    `Expiry: ${plan.expiresAtUtc} (${plan.timezone})`,
    `Revision: ${plan.revision}`,
    `Digest: ${plan.planHash}`,
    '',
    'Confirm these exact immutable terms with:',
    `/confirm ${plan.id} ${plan.revision} ${plan.planHash}`,
    '',
    'Approval only arms monitoring. It does not mean an order was accepted or filled.',
  ].join('\n');
}

export function formatPlanSummary(plan: TradePlan): string {
  return `${plan.id} | ${plan.side} BTCUSDT | ${plan.state} | rev ${plan.revision}`;
}

export function formatPlanStatus(
  plan: TradePlan,
  attempt: OrderAttempt | null,
  nowUtc?: string,
): string {
  const prefix = `Plan ${plan.id}: ${plan.state}.`;
  const detail = statusDetail(plan, attempt, nowUtc);
  const evidence = attempt
    ? ` Attempt ${attempt.id}: ${attempt.state}${attempt.venueStatus ? ` / ${attempt.venueStatus}` : ''} (${attempt.evidenceSource}).`
    : ' No order attempt is recorded.';
  return `${prefix} ${detail}${evidence}`;
}

function statusDetail(
  plan: TradePlan,
  attempt: OrderAttempt | null,
  nowUtc?: string,
): string {
  switch (plan.state) {
    case 'DRAFT':
    case 'AWAITING_CONFIRMATION':
      return nowUtc !== undefined &&
        compareUtcTimestamps(nowUtc, plan.expiresAtUtc) >= 0
        ? 'Not approved and expired; no order is authorized.'
        : 'Not approved; no order is authorized.';
    case 'ARMED':
      return 'Approved and armed; no order has been accepted.';
    case 'TRIGGERED':
      return 'The trigger was observed; no order acceptance is established.';
    case 'SUBMITTING':
      return 'Submission started, but the outcome is not yet established.';
    case 'OPEN':
      return 'The paper order was accepted/open; acceptance is not a fill.';
    case 'PARTIALLY_FILLED':
      return 'A simulated paper partial fill is recorded; the remainder may still be open.';
    case 'FILLED':
      return attempt?.state === 'RECONCILED' && attempt.venueStatus === 'FILLED'
        ? 'A simulated paper fill is confirmed by reconciled readback evidence.'
        : 'The plan says filled, but reconciled fill evidence is not available here.';
    case 'REJECTED':
      return 'The paper order was rejected; no fill is claimed.';
    case 'UNCERTAIN':
      return 'Execution outcome is uncertain. Do not resubmit automatically.';
    case 'CANCEL_REQUESTED':
      return 'Cancellation was requested, but cancellation is not yet confirmed.';
    case 'CANCELLED':
      return attempt === null
        ? 'Cancelled before submission; no order was sent.'
        : 'Cancellation is recorded; see the attempt evidence for its readback state.';
    case 'EXPIRED':
      return 'The instruction expired; no new submission is authorized.';
    case 'NEEDS_HUMAN':
      return 'The outcome requires human review; no success is claimed.';
  }
}
