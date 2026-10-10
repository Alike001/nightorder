import { createHash } from 'node:crypto';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  InvalidPlanTransitionError,
  acceptedVenueStatusSchema,
  cancelRequestToolResultSchema,
  canonicalizeTradeInstruction,
  compareDecimalStrings,
  compareUtcTimestamps,
  hashTradeInstruction,
  hasValidPlanHash,
  ianaTimezoneSchema,
  marketQuoteSchema,
  orderReadbackResultSchema,
  orderAttemptSchema,
  orderStatusResultSchema,
  positiveDecimalSchema,
  toolResultSchema,
  submitApprovedOrderResultSchema,
  tradePlanSchema,
  utcTimestampSchema,
  validatePlanTransition,
  verificationResultSchema,
  type ExecutionPort,
  type MarketDataPort,
  type PlanRepository,
  type ToolResult,
  type TradePlan,
  type VerificationPort,
} from '../src/index.js';
import {
  armedPlan,
  BUY_INSTRUCTION,
  draftPlan,
  VALID_QUOTE,
} from './fixtures.js';

const APPROVED_AT_UTC = '2026-10-10T20:00:00.000Z';
const BEFORE_EXPIRY_UTC = '2026-10-11T05:59:59.999Z';
const AT_EXPIRY_UTC = '2026-10-11T06:00:00.000Z';
const PASSING_VERIFICATION_CHECKS = {
  PLAN_HASH_MATCHES: true,
  PLAN_APPROVED: true,
  OWNER_AUTHORIZATION_MATCHES: true,
  PLAN_NOT_EXPIRED_AT_SUBMISSION: true,
  ORDER_ATTEMPT_UNIQUE: true,
  ORDER_REQUEST_MATCHES_PLAN: true,
  EXECUTION_STATUS_MATCHES: true,
  CANCELLATION_STATE_MATCHES: true,
  PAPER_EVIDENCE_ONLY: true,
} as const;

describe('TradePlan schema', () => {
  it('accepts an exact paper-only BTCUSDT plan', () => {
    expect(tradePlanSchema.parse(draftPlan())).toEqual(draftPlan());
  });

  it('accepts a SELL plan sized only in BTC', () => {
    const sell = draftPlan({
      side: 'SELL',
      quoteBudgetUsdt: undefined,
      baseQuantityBtc: '0.001000000000000001',
      triggerOperator: 'BID_GTE',
      limitPrice: '59990',
    });
    expect(tradePlanSchema.parse(sell).baseQuantityBtc).toBe(
      '0.001000000000000001',
    );
  });

  it.each([
    ['disallowed symbol', { symbol: 'ETHUSDT' }],
    ['non-paper mode', { mode: 'TESTNET' }],
    ['binary number amount', { quoteBudgetUsdt: 50 }],
    ['exponent notation', { quoteBudgetUsdt: '5e1' }],
    ['signed decimal', { quoteBudgetUsdt: '+50' }],
    ['leading zero', { quoteBudgetUsdt: '050.0' }],
    ['zero amount', { quoteBudgetUsdt: '0.000' }],
    ['wrong BUY operator', { triggerOperator: 'BID_GTE' }],
    ['BUY base quantity', { baseQuantityBtc: '0.001' }],
    ['BUY without budget', { quoteBudgetUsdt: undefined }],
    ['non-UTC expiry', { expiresAtUtc: '2026-10-11T07:00:00+01:00' }],
    ['invalid timezone', { timezone: 'GMT+1' }],
  ])('rejects %s', (_label, change) => {
    expect(
      tradePlanSchema.safeParse({ ...draftPlan(), ...change }).success,
    ).toBe(false);
  });

  it('requires approval metadata for an armed plan', () => {
    expect(
      tradePlanSchema.safeParse({ ...draftPlan(), state: 'ARMED', revision: 2 })
        .success,
    ).toBe(false);
  });
});

describe('canonical authorization hash', () => {
  it('matches SHA-256 over the documented canonical JSON preimage', () => {
    const canonical = canonicalizeTradeInstruction(BUY_INSTRUCTION);
    const independentDigest = createHash('sha256')
      .update(canonical, 'utf8')
      .digest('hex');

    expect(hashTradeInstruction(BUY_INSTRUCTION)).toBe(independentDigest);
    expect(canonical).toBe(
      '{"id":"plan-001","ownerId":"telegram-123","symbol":"BTCUSDT","side":"BUY","quoteBudgetUsdt":"50.000000000000000001","triggerPrice":"60000.000000000000000001","triggerOperator":"ASK_LTE","limitPrice":"60000.000000000000000000","expiresAtUtc":"2026-10-11T06:00:00.000Z","timezone":"Africa/Lagos","mode":"PAPER"}',
    );
  });

  it('detects a modified instruction after approval', () => {
    const approved = armedPlan();
    const modified = { ...approved, limitPrice: '59999.99' };

    expect(hasValidPlanHash(approved)).toBe(true);
    expect(hasValidPlanHash(modified)).toBe(false);
    expect(tradePlanSchema.safeParse(modified).success).toBe(false);
    expect(() =>
      validatePlanTransition(
        approved,
        { ...modified, state: 'TRIGGERED', revision: 3 },
        BEFORE_EXPIRY_UTC,
      ),
    ).toThrow('Plan digest');
  });

  it('keeps precision-sensitive inputs distinct', () => {
    const a = { ...BUY_INSTRUCTION, quoteBudgetUsdt: '50.000000000000000001' };
    const b = { ...BUY_INSTRUCTION, quoteBudgetUsdt: '50.000000000000000002' };
    expect(hashTradeInstruction(a)).not.toBe(hashTradeInstruction(b));
  });
});

describe('safe state transitions and revisions', () => {
  it('accepts the approval transition only with an exact hash and next revision', () => {
    const awaiting = {
      ...draftPlan(),
      state: 'AWAITING_CONFIRMATION' as const,
      revision: 1,
    };
    expect(
      validatePlanTransition(awaiting, armedPlan(), APPROVED_AT_UTC),
    ).toEqual(armedPlan());
  });

  it('permits pre-approval edits only when their digest is recomputed', () => {
    const awaiting = {
      ...draftPlan(),
      state: 'AWAITING_CONFIRMATION' as const,
      revision: 1,
    };
    const editedDraft = draftPlan({ quoteBudgetUsdt: '49.99', revision: 2 });
    expect(
      validatePlanTransition(awaiting, editedDraft, APPROVED_AT_UTC),
    ).toEqual(editedDraft);
    expect(() =>
      validatePlanTransition(
        awaiting,
        { ...editedDraft, quoteBudgetUsdt: '49.98' },
        APPROVED_AT_UTC,
      ),
    ).toThrow('Plan digest');
  });

  it('rejects skipping states', () => {
    expect(() =>
      validatePlanTransition(
        armedPlan(),
        { ...armedPlan(), state: 'FILLED', revision: 3 },
        BEFORE_EXPIRY_UTC,
      ),
    ).toThrow(InvalidPlanTransitionError);
  });

  it('rejects stale and skipped revisions', () => {
    for (const revision of [2, 4]) {
      expect(() =>
        validatePlanTransition(
          armedPlan(),
          { ...armedPlan(), state: 'TRIGGERED', revision },
          BEFORE_EXPIRY_UTC,
        ),
      ).toThrow('Revision must advance exactly once');
    }
  });

  it('does not treat cancel requested as cancelled', () => {
    const open = { ...armedPlan(), state: 'OPEN' as const, revision: 5 };
    const requested = {
      ...open,
      state: 'CANCEL_REQUESTED' as const,
      revision: 6,
    };
    expect(
      validatePlanTransition(open, requested, '2026-10-12T00:00:00Z').state,
    ).toBe('CANCEL_REQUESTED');
  });

  it('rejects triggering, submitting, or local cancellation at expiry', () => {
    expect(() =>
      validatePlanTransition(
        armedPlan(),
        { ...armedPlan(), state: 'TRIGGERED', revision: 3 },
        AT_EXPIRY_UTC,
      ),
    ).toThrow('at or after plan expiry');
    expect(() =>
      validatePlanTransition(
        armedPlan(),
        { ...armedPlan(), state: 'CANCELLED', revision: 3 },
        AT_EXPIRY_UTC,
      ),
    ).toThrow('must be marked EXPIRED');
  });

  it('rejects presenting an already-expired plan for confirmation', () => {
    expect(() =>
      validatePlanTransition(
        draftPlan(),
        {
          ...draftPlan(),
          state: 'AWAITING_CONFIRMATION',
          revision: 1,
        },
        AT_EXPIRY_UTC,
      ),
    ).toThrow('at or after plan expiry');
  });

  it('allows expiry only when the approved plan has actually expired', () => {
    const expired = { ...armedPlan(), state: 'EXPIRED' as const, revision: 3 };
    expect(() =>
      validatePlanTransition(armedPlan(), expired, BEFORE_EXPIRY_UTC),
    ).toThrow('cannot expire before');
    expect(
      validatePlanTransition(armedPlan(), expired, AT_EXPIRY_UTC).state,
    ).toBe('EXPIRED');
  });

  it('requires the recorded approval time to equal the arming transition time', () => {
    const awaiting = {
      ...draftPlan(),
      state: 'AWAITING_CONFIRMATION' as const,
      revision: 1,
    };
    expect(() =>
      validatePlanTransition(awaiting, armedPlan(), '2026-10-10T20:00:00.001Z'),
    ).toThrow('Approval time must equal');
  });

  it('does not allow an open order to become rejected', () => {
    const open = { ...armedPlan(), state: 'OPEN' as const, revision: 5 };
    expect(() =>
      validatePlanTransition(
        open,
        { ...open, state: 'REJECTED', revision: 6 },
        BEFORE_EXPIRY_UTC,
      ),
    ).toThrow('OPEN -> REJECTED');
  });
});

describe('precision, time, and supporting contracts', () => {
  it.each(['0.000000000000000001', '60000', '60000.000000000000000001'])(
    'accepts precise positive decimal %s',
    (value) => expect(positiveDecimalSchema.parse(value)).toBe(value),
  );

  it('compares arbitrary precision decimal strings without Number conversion', () => {
    expect(
      compareDecimalStrings(
        '9007199254740993.000000000000000001',
        '9007199254740993.000000000000000002',
      ),
    ).toBe(-1);
    expect(compareDecimalStrings('1.0', '1.000000000000000000')).toBe(0);
  });

  it('validates UTC timestamps and IANA zones', () => {
    expect(utcTimestampSchema.parse('2026-10-10T12:34:56.123456Z')).toContain(
      'Z',
    );
    expect(utcTimestampSchema.safeParse('2026-02-30T12:00:00Z').success).toBe(
      false,
    );
    expect(ianaTimezoneSchema.parse('Africa/Lagos')).toBe('Africa/Lagos');
    expect(
      compareUtcTimestamps(
        '2026-10-10T12:00:00Z',
        '2026-10-10T12:00:00.000001Z',
      ),
    ).toBe(-1);
  });

  it('rejects crossed quotes while preserving fine precision', () => {
    expect(marketQuoteSchema.parse(VALID_QUOTE)).toEqual(VALID_QUOTE);
    expect(
      marketQuoteSchema.safeParse({
        ...VALID_QUOTE,
        bestBid: '60000.000000000000000002',
      }).success,
    ).toBe(false);
  });

  it('keeps order evidence paper-only and reconciliation explicit', () => {
    const attempt = {
      id: 'attempt-1',
      planId: 'plan-001',
      operationId: 'operation-1',
      clientOrderId: 'nightorder-plan-001',
      requestDigest: 'a'.repeat(64),
      remoteOrderId: 'paper-order-1',
      state: 'RECONCILED',
      venueStatus: 'FILLED',
      evidenceSource: 'ORIGINAL_PAPER',
      createdAtUtc: '2026-10-10T20:00:00Z',
      reconciledAtUtc: '2026-10-10T20:00:01Z',
    };
    expect(orderAttemptSchema.parse(attempt)).toEqual(attempt);
    expect(
      orderAttemptSchema.safeParse({
        ...attempt,
        evidenceSource: 'BINANCE_TESTNET',
      }).success,
    ).toBe(false);
  });

  it('does not allow uncertain attempts to claim a known venue outcome', () => {
    expect(
      orderAttemptSchema.safeParse({
        id: 'attempt-1',
        planId: 'plan-001',
        operationId: 'operation-1',
        clientOrderId: 'nightorder-plan-001',
        requestDigest: 'a'.repeat(64),
        state: 'UNCERTAIN',
        venueStatus: 'FILLED',
        evidenceSource: 'ORIGINAL_PAPER',
        createdAtUtc: '2026-10-10T20:00:00Z',
      }).success,
    ).toBe(false);
  });

  it('requires acknowledged attempts to carry remote evidence', () => {
    expect(
      orderAttemptSchema.safeParse({
        id: 'attempt-1',
        planId: 'plan-001',
        operationId: 'operation-1',
        clientOrderId: 'nightorder-plan-001',
        requestDigest: 'a'.repeat(64),
        state: 'ACKNOWLEDGED',
        evidenceSource: 'ORIGINAL_PAPER',
        createdAtUtc: '2026-10-10T20:00:00Z',
      }).success,
    ).toBe(false);
  });

  it('validates machine-readable verification results', () => {
    expect(
      verificationResultSchema.parse({
        result: 'VERIFIED',
        checks: PASSING_VERIFICATION_CHECKS,
        evidenceIds: ['plan-read', 'paper-order-read'],
      }).result,
    ).toBe('VERIFIED');
  });

  it('rejects VERIFIED when a required check fails or is missing', () => {
    expect(
      verificationResultSchema.safeParse({
        result: 'VERIFIED',
        checks: {
          ...PASSING_VERIFICATION_CHECKS,
          EXECUTION_STATUS_MATCHES: false,
        },
        evidenceIds: ['plan-read'],
      }).success,
    ).toBe(false);
    expect(
      verificationResultSchema.safeParse({
        result: 'VERIFIED',
        checks: {
          PLAN_HASH_MATCHES: true,
          OWNER_AUTHORIZATION_MATCHES: true,
          PLAN_NOT_EXPIRED_AT_SUBMISSION: true,
          ORDER_ATTEMPT_UNIQUE: true,
          ORDER_REQUEST_MATCHES_PLAN: true,
          EXECUTION_STATUS_MATCHES: true,
          CANCELLATION_STATE_MATCHES: true,
          PAPER_EVIDENCE_ONLY: true,
        },
        evidenceIds: ['plan-read'],
      }).success,
    ).toBe(false);
  });

  it('rejects verification without unique evidence references', () => {
    for (const evidenceIds of [[], ['plan-read', 'plan-read']]) {
      expect(
        verificationResultSchema.safeParse({
          result: 'VERIFIED',
          checks: PASSING_VERIFICATION_CHECKS,
          evidenceIds,
        }).success,
      ).toBe(false);
    }
  });

  it('rejects a non-verified result when every required check passed', () => {
    expect(
      verificationResultSchema.safeParse({
        result: 'UNCERTAIN',
        checks: PASSING_VERIFICATION_CHECKS,
        evidenceIds: ['verification-read'],
      }).success,
    ).toBe(false);
  });

  it('accepts an evidence-backed blocked result with a failed check', () => {
    expect(
      verificationResultSchema.parse({
        result: 'BLOCKED',
        checks: {
          ...PASSING_VERIFICATION_CHECKS,
          OWNER_AUTHORIZATION_MATCHES: false,
        },
        evidenceIds: ['authorization-read'],
      }).result,
    ).toBe('BLOCKED');
  });

  it('rejects unknown and ambiguous execution statuses at runtime', () => {
    for (const status of ['UNKNOWN', 'UNCERTAIN', 'ORDER_ACCEPTED']) {
      expect(
        orderStatusResultSchema.safeParse({ orderId: 'paper-order-1', status })
          .success,
      ).toBe(false);
      expect(
        submitApprovedOrderResultSchema.safeParse({
          ok: true,
          data: { orderId: 'paper-order-1', status },
          evidenceId: 'paper-submit',
        }).success,
      ).toBe(false);
    }
    expect(acceptedVenueStatusSchema.safeParse('REJECTED').success).toBe(false);
    expect(
      submitApprovedOrderResultSchema.safeParse({
        ok: true,
        data: { orderId: 'paper-order-1', status: 'REJECTED' },
        evidenceId: 'paper-submit',
      }).success,
    ).toBe(false);
  });

  it('validates readback quantities against typed venue statuses', () => {
    expect(
      orderReadbackResultSchema.safeParse({
        orderId: 'paper-order-1',
        status: 'FILLED',
        filledQuantity: '0',
      }).success,
    ).toBe(false);
    expect(
      orderReadbackResultSchema.safeParse({
        orderId: 'paper-order-1',
        status: 'NEW',
        filledQuantity: '0.001',
      }).success,
    ).toBe(false);
  });

  it('keeps cancellation acknowledgement distinct from cancellation confirmation', () => {
    expect(
      cancelRequestToolResultSchema.parse({
        ok: true,
        data: { status: 'CANCEL_REQUESTED' },
        evidenceId: 'paper-cancel-request',
      }).ok,
    ).toBe(true);
    expect(
      cancelRequestToolResultSchema.safeParse({
        ok: true,
        data: { status: 'CANCELED' },
        evidenceId: 'paper-cancel-request',
      }).success,
    ).toBe(false);
  });

  it('validates both branches of a ToolResult', () => {
    const schema = toolResultSchema(positiveDecimalSchema);
    expect(
      schema.parse({ ok: true, data: '0.0001', evidenceId: 'balance-read' }).ok,
    ).toBe(true);
    expect(
      schema.parse({
        ok: false,
        code: 'STALE_QUOTE',
        message: 'Quote exceeded the freshness window',
        retrySafe: true,
        evidenceId: 'quote-read',
      }).ok,
    ).toBe(false);
  });

  it('exports independently implementable typed ports', () => {
    expectTypeOf<MarketDataPort>().toBeObject();
    expectTypeOf<ExecutionPort>().toBeObject();
    expectTypeOf<PlanRepository>().toBeObject();
    expectTypeOf<VerificationPort>().toBeObject();
    expectTypeOf<ToolResult<TradePlan>>().toMatchTypeOf<
      | { ok: true; data: TradePlan; evidenceId: string }
      | {
          ok: false;
          code: string;
          message: string;
          retrySafe: boolean;
          evidenceId: string;
        }
    >();
  });
});
