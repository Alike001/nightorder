import {
  hashTradeInstruction,
  type OrderAttempt,
  type TradePlan,
} from '@nightorder/domain';
import { describe, expect, it } from 'vitest';
import {
  FixturePaperExecutionAdapter,
  InMemoryTelegramPlanRepository,
  TelegramInstructionWorkflow,
  type Clock,
  type InstructionInterpreter,
  type InstructionProposal,
  type TelegramMessage,
  type TelegramTraceEvent,
  type TelegramTraceSink,
} from '../src/index.js';

const OWNER = 'telegram-123';
const OTHER_OWNER = 'telegram-456';
const NOW = '2026-10-10T20:00:00.000Z';
const EXPIRY = '2026-10-11T06:00:00.000Z';

const COMPLETE_PROPOSAL: InstructionProposal = {
  asset: 'BTCUSDT',
  side: 'BUY',
  quoteBudgetUsdt: '50.000000000000000001',
  baseQuantityBtc: null,
  triggerPrice: '60000.000000000000000001',
  triggerOperator: 'ASK_LTE',
  limitPrice: '60000.000000000000000000',
  expiresAtUtc: EXPIRY,
  timezone: 'Africa/Lagos',
};

class MutableClock implements Clock {
  constructor(public value = NOW) {}
  nowUtc(): string {
    return this.value;
  }
}

class FakeInterpreter implements InstructionInterpreter {
  calls = 0;
  constructor(private readonly proposals: readonly InstructionProposal[]) {}
  async interpret(): Promise<InstructionProposal> {
    const proposal =
      this.proposals[Math.min(this.calls, this.proposals.length - 1)];
    this.calls += 1;
    if (!proposal) throw new Error('No fixture proposal');
    return structuredClone(proposal);
  }
}

class RecordingTrace implements TelegramTraceSink {
  readonly events: TelegramTraceEvent[] = [];
  record(event: TelegramTraceEvent): void {
    this.events.push(structuredClone(event));
  }
  async runSpan<T>(
    event: TelegramTraceEvent,
    operation: (scope: {
      setAttribute(name: string, value: string | number | boolean): void;
    }) => Promise<T>,
  ): Promise<T> {
    const attributes = { ...event.attributes };
    this.events.push({ ...structuredClone(event), attributes });
    return operation({
      setAttribute(name, value) {
        attributes[name] = value;
      },
    });
  }
}

interface Harness {
  readonly clock: MutableClock;
  readonly interpreter: FakeInterpreter;
  readonly repository: InMemoryTelegramPlanRepository;
  readonly trace: RecordingTrace;
  readonly workflow: TelegramInstructionWorkflow;
  send(
    text: string,
    userId?: string,
  ): Promise<
    ReturnType<TelegramInstructionWorkflow['handle']> extends Promise<infer T>
      ? T
      : never
  >;
}

function harness(
  proposals: readonly InstructionProposal[] = [COMPLETE_PROPOSAL],
  allowedUserIds: readonly string[] = [OWNER],
): Harness {
  const clock = new MutableClock();
  const interpreter = new FakeInterpreter(proposals);
  const repository = new InMemoryTelegramPlanRepository(clock);
  const trace = new RecordingTrace();
  const workflow = new TelegramInstructionWorkflow({
    allowedUserIds,
    repository,
    interpreter,
    clock,
    planIdGenerator: { nextPlanId: () => 'plan-telegram-001' },
    trace,
  });
  let update = 0;
  return {
    clock,
    interpreter,
    repository,
    trace,
    workflow,
    async send(text, userId = OWNER) {
      update += 1;
      const message: TelegramMessage = {
        updateId: `update-${update}`,
        chatId: `chat-${userId}`,
        userId,
        text,
      };
      return workflow.handle(message);
    },
  };
}

async function createAwaitingPlan(testHarness: Harness): Promise<TradePlan> {
  const reply = await testHarness.send(
    '/new Buy 50 USDT BTC/USDT if ask <= 60000, limit 60000, expire 07:00 Africa/Lagos',
  );
  expect(reply.kind).toBe('PREVIEW');
  const plan = await testHarness.repository.loadPlan('plan-telegram-001');
  if (!plan) throw new Error('Expected fixture plan');
  return plan;
}

function approvalCommand(plan: TradePlan): string {
  return `/confirm ${plan.id} ${plan.revision} ${plan.planHash}`;
}

function approvedPlan(state: TradePlan['state'], revision: number): TradePlan {
  const instruction = {
    id: `plan-${state.toLowerCase()}`,
    ownerId: OWNER,
    symbol: 'BTCUSDT' as const,
    side: 'BUY' as const,
    quoteBudgetUsdt: '50',
    triggerPrice: '60000',
    triggerOperator: 'ASK_LTE' as const,
    limitPrice: '60000',
    expiresAtUtc: EXPIRY,
    timezone: 'Africa/Lagos',
    mode: 'PAPER' as const,
  };
  return {
    ...instruction,
    planHash: hashTradeInstruction(instruction),
    approvedAtUtc: NOW,
    state,
    revision,
  };
}

describe('Telegram authorization and command surface', () => {
  it('supports /start without exposing anything outside the paper boundary', async () => {
    const testHarness = harness();
    const reply = await testHarness.send('/start');
    expect(reply.text).toContain('PAPER ONLY');
    expect(reply.text).toContain('/new');
    expect(reply.text).toContain('/plans');
    expect(reply.text).toContain('/status');
    expect(reply.text).toContain('/cancel');
  });

  it('rejects a user absent from the server-side allowlist before invoking the model', async () => {
    const testHarness = harness();
    const reply = await testHarness.send('/new buy bitcoin', OTHER_OWNER);
    expect(reply.kind).toBe('ERROR');
    expect(reply.text).toContain('Unauthorized');
    expect(testHarness.interpreter.calls).toBe(0);
    expect(await testHarness.repository.listPlansByOwner(OTHER_OWNER)).toEqual(
      [],
    );
    expect(testHarness.trace.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'telegram.instruction_workflow',
          kind: 'WORKFLOW',
        }),
        expect.objectContaining({
          name: 'telegram.authorization.denied',
          kind: 'GUARDRAIL',
          attributes: expect.objectContaining({ passed: false }),
        }),
      ]),
    );
  });

  it('correlates one update by run ID and generates a fresh ID for the next update', async () => {
    const testHarness = harness();
    await testHarness.send('/new buy bitcoin', OTHER_OWNER);
    await testHarness.send('/new buy bitcoin', OTHER_OWNER);
    const workflows = testHarness.trace.events.filter(
      ({ kind }) => kind === 'WORKFLOW',
    );
    const refusals = testHarness.trace.events.filter(
      ({ name }) => name === 'telegram.authorization.denied',
    );
    expect(workflows).toHaveLength(2);
    expect(refusals).toHaveLength(2);
    expect(refusals[0]?.runId).toBe(workflows[0]?.runId);
    expect(refusals[1]?.runId).toBe(workflows[1]?.runId);
    expect(workflows[0]?.runId).not.toBe(workflows[1]?.runId);
  });

  it('lists only the authorized owner’s persisted plans', async () => {
    const testHarness = harness([COMPLETE_PROPOSAL], [OWNER, OTHER_OWNER]);
    const plan = await createAwaitingPlan(testHarness);
    const ownerReply = await testHarness.send('/plans');
    const otherReply = await testHarness.send('/plans', OTHER_OWNER);
    expect(ownerReply.text).toContain(plan.id);
    expect(otherReply.text).toBe('You have no persisted plans.');
  });
});

describe('clarification and exact preview', () => {
  it.each([
    ['asset', { asset: null }, 'Asset:'],
    ['direction', { side: null }, 'Direction:'],
    ['amount', { quoteBudgetUsdt: null }, 'maximum USDT budget'],
    ['price condition', { triggerPrice: null }, 'Price condition:'],
    ['execution limit', { limitPrice: null }, 'Execution limit:'],
    ['expiry', { expiresAtUtc: null }, 'Expiry:'],
  ])(
    'asks for clarification when %s is ambiguous',
    async (_label, change, expected) => {
      const proposal = {
        ...COMPLETE_PROPOSAL,
        ...change,
      } as InstructionProposal;
      const testHarness = harness([proposal]);
      const reply = await testHarness.send('/new incomplete instruction');
      expect(reply.kind).toBe('CLARIFICATION');
      expect(reply.text).toContain(expected);
      expect(await testHarness.repository.listPlansByOwner(OWNER)).toEqual([]);
    },
  );

  it('continues a /new conversation and only persists after ambiguity is resolved', async () => {
    const ambiguous = { ...COMPLETE_PROPOSAL, limitPrice: null };
    const testHarness = harness([ambiguous, COMPLETE_PROPOSAL]);
    expect((await testHarness.send('/new buy BTC')).kind).toBe('CLARIFICATION');
    const preview = await testHarness.send('Worst limit is 60000 USDT/BTC.');
    expect(preview.kind).toBe('PREVIEW');
    expect(preview.text).toContain(`Digest:`);
    expect(preview.text).toContain('/confirm plan-telegram-001 1 ');
  });

  it('rejects precision-unsafe model values through shared decimal validation', async () => {
    const proposal = { ...COMPLETE_PROPOSAL, quoteBudgetUsdt: '5e1' };
    const testHarness = harness([proposal]);
    const reply = await testHarness.send('/new buy with 5e1 USDT');
    expect(reply.kind).toBe('CLARIFICATION');
    expect(reply.text).toContain('maximum USDT budget');
  });

  it('shows every immutable term and never submits through the fixture execution adapter', async () => {
    const testHarness = harness();
    const execution = new FixturePaperExecutionAdapter();
    const plan = await createAwaitingPlan(testHarness);
    const preview = await testHarness.send('/status plan-telegram-001');
    expect(plan.state).toBe('AWAITING_CONFIRMATION');
    expect(preview.text).toContain('Not approved');
    expect(execution.submissionCount).toBe(0);
    expect(JSON.stringify(testHarness.trace.events)).not.toContain(
      'Buy 50 USDT',
    );
    expect(testHarness.trace.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'telegram.interpret_instruction',
          kind: 'AGENT',
        }),
        expect.objectContaining({
          name: 'telegram.instruction.validation',
          kind: 'GUARDRAIL',
        }),
      ]),
    );
    expect(JSON.stringify(testHarness.trace.events)).not.toContain(
      'plan-telegram-001',
    );
  });
});

describe('approval safety', () => {
  it('arms only the exact digest and revision confirmed by the owner', async () => {
    const testHarness = harness();
    const awaiting = await createAwaitingPlan(testHarness);
    const reply = await testHarness.send(approvalCommand(awaiting));
    const armed = await testHarness.repository.loadPlan(awaiting.id);
    expect(reply.kind).toBe('APPROVED');
    expect(reply.text).toContain('No order has been accepted or filled');
    expect(armed?.state).toBe('ARMED');
    expect(armed?.approvedAtUtc).toBe(NOW);
    const approvalEvents = testHarness.trace.events.filter((event) =>
      event.name.startsWith('telegram.approval.'),
    );
    expect(approvalEvents.map(({ name, kind }) => [name, kind])).toEqual([
      ['telegram.approval.command_validation', 'GUARDRAIL'],
      ['telegram.approval.attempt', 'TOOL'],
      ['telegram.approval.authorization', 'GUARDRAIL'],
    ]);
    expect(approvalEvents[2]?.attributes).toMatchObject({ passed: true });
    expect(approvalEvents[1]?.pseudonymousPlanId).toMatch(
      /^plan_[a-f0-9]{24}$/,
    );
    expect(approvalEvents[1]?.pseudonymousPlanId).toBe(
      testHarness.trace.events.find(
        ({ name }) => name === 'telegram.plan.previewed',
      )?.pseudonymousPlanId,
    );
    expect(JSON.stringify(approvalEvents)).not.toContain(awaiting.id);
  });

  it('rejects a modified digest and leaves the plan awaiting confirmation', async () => {
    const testHarness = harness();
    const awaiting = await createAwaitingPlan(testHarness);
    const reply = await testHarness.send(
      `/confirm ${awaiting.id} ${awaiting.revision} ${'a'.repeat(64)}`,
    );
    expect(reply.text).toContain('not approved');
    expect((await testHarness.repository.loadPlan(awaiting.id))?.state).toBe(
      'AWAITING_CONFIRMATION',
    );
  });

  it('does not let one allowlisted user approve another user’s plan', async () => {
    const testHarness = harness([COMPLETE_PROPOSAL], [OWNER, OTHER_OWNER]);
    const awaiting = await createAwaitingPlan(testHarness);
    const reply = await testHarness.send(
      approvalCommand(awaiting),
      OTHER_OWNER,
    );
    expect(reply.text).toContain('Only the plan owner');
    expect((await testHarness.repository.loadPlan(awaiting.id))?.state).toBe(
      'AWAITING_CONFIRMATION',
    );
  });

  it('rejects duplicate confirmation without another state change', async () => {
    const testHarness = harness();
    const awaiting = await createAwaitingPlan(testHarness);
    expect((await testHarness.send(approvalCommand(awaiting))).kind).toBe(
      'APPROVED',
    );
    const duplicate = await testHarness.send(approvalCommand(awaiting));
    expect(duplicate.text).toContain('not approved');
    expect((await testHarness.repository.loadPlan(awaiting.id))?.revision).toBe(
      2,
    );
  });

  it('rejects a confirmation for a stale plan revision even if an old digest is replayed', async () => {
    const testHarness = harness();
    const original = await createAwaitingPlan(testHarness);
    const changedInstruction = {
      ...original,
      quoteBudgetUsdt: '49.99',
      state: 'DRAFT' as const,
      revision: 2,
      approvedAtUtc: undefined,
    };
    const revisedDraft = {
      ...changedInstruction,
      planHash: hashTradeInstruction(changedInstruction),
    };
    const draftResult = await testHarness.repository.saveTransition(
      revisedDraft,
      original.revision,
      NOW,
    );
    expect(draftResult.ok).toBe(true);
    const awaitingResult = await testHarness.repository.saveTransition(
      { ...revisedDraft, state: 'AWAITING_CONFIRMATION', revision: 3 },
      2,
      NOW,
    );
    expect(awaitingResult.ok).toBe(true);

    const reply = await testHarness.send(approvalCommand(original));
    expect(reply.text).toContain('revision changed');
    expect((await testHarness.repository.loadPlan(original.id))?.state).toBe(
      'AWAITING_CONFIRMATION',
    );
  });

  it('rejects approval at expiry', async () => {
    const testHarness = harness();
    const awaiting = await createAwaitingPlan(testHarness);
    testHarness.clock.value = EXPIRY;
    const reply = await testHarness.send(approvalCommand(awaiting));
    expect(reply.text).toContain('expired before approval');
    expect((await testHarness.repository.loadPlan(awaiting.id))?.state).toBe(
      'AWAITING_CONFIRMATION',
    );
  });
});

describe('cancellation and truthful reporting', () => {
  it('cancels an armed plan before submission', async () => {
    const testHarness = harness();
    const awaiting = await createAwaitingPlan(testHarness);
    await testHarness.send(approvalCommand(awaiting));
    const reply = await testHarness.send(`/cancel ${awaiting.id}`);
    expect(reply.text).toContain('cancelled before submission');
    expect((await testHarness.repository.loadPlan(awaiting.id))?.state).toBe(
      'CANCELLED',
    );
  });

  it('reports an open-order cancellation as requested, never completed', async () => {
    const testHarness = harness();
    const open = approvedPlan('OPEN', 5);
    testHarness.repository.seedPlan(open);
    const reply = await testHarness.send(`/cancel ${open.id}`);
    expect(reply.text).toContain('cancellation requested');
    expect(reply.text).toContain('not cancelled');
    expect((await testHarness.repository.loadPlan(open.id))?.state).toBe(
      'CANCEL_REQUESTED',
    );
  });

  it('does not let another allowlisted user cancel the owner’s plan', async () => {
    const testHarness = harness([COMPLETE_PROPOSAL], [OWNER, OTHER_OWNER]);
    const open = approvedPlan('OPEN', 5);
    testHarness.repository.seedPlan(open);
    const reply = await testHarness.send(`/cancel ${open.id}`, OTHER_OWNER);
    expect(reply.text).toContain('Only the plan owner');
    expect((await testHarness.repository.loadPlan(open.id))?.state).toBe(
      'OPEN',
    );
  });

  it.each([
    ['OPEN', 'accepted/open; acceptance is not a fill'],
    ['REJECTED', 'rejected; no fill is claimed'],
    ['UNCERTAIN', 'outcome is uncertain'],
    ['CANCEL_REQUESTED', 'not yet confirmed'],
  ] as const)(
    'reports %s without overstating the outcome',
    async (state, text) => {
      const testHarness = harness();
      const plan = approvedPlan(state, 5);
      testHarness.repository.seedPlan(plan);
      const reply = await testHarness.send(`/status ${plan.id}`);
      expect(reply.text).toContain(text);
    },
  );

  it('labels a reconciled paper fill as simulated and evidence-backed', async () => {
    const testHarness = harness();
    const plan = approvedPlan('FILLED', 6);
    const attempt: OrderAttempt = {
      id: 'attempt-filled',
      planId: plan.id,
      operationId: 'operation-filled',
      clientOrderId: 'client-filled',
      requestDigest: plan.planHash,
      remoteOrderId: 'fixture-order-filled',
      state: 'RECONCILED',
      venueStatus: 'FILLED',
      evidenceSource: 'ORIGINAL_PAPER',
      createdAtUtc: '2026-10-10T20:01:00.000Z',
      reconciledAtUtc: '2026-10-10T20:02:00.000Z',
    };
    testHarness.repository.seedPlan(plan);
    testHarness.repository.seedAttempt(attempt);
    const reply = await testHarness.send(`/status ${plan.id}`);
    expect(reply.text).toContain('simulated paper fill');
    expect(reply.text).toContain('reconciled readback evidence');
  });

  it('keeps fixture order acceptance and cancellation separate from fill/readback', async () => {
    const execution = new FixturePaperExecutionAdapter();
    const accepted = await execution.submitApprovedOrder({
      clientOrderId: 'fixture-client-1',
      planId: 'fixture-plan-1',
      symbol: 'BTCUSDT',
      side: 'BUY',
      quantity: '0.001',
      limitPrice: '60000',
    });
    expect(accepted.ok && accepted.data.status).toBe('NEW');
    const cancellation = await execution.requestCancel('fixture-client-1');
    expect(cancellation.ok && cancellation.data.status).toBe(
      'CANCEL_REQUESTED',
    );
    const readback = await execution.findOrderByClientId('fixture-client-1');
    expect(readback.ok && readback.data.status).toBe('NEW');
    expect(readback.ok && readback.data.filledQuantity).toBe('0');
  });
});
