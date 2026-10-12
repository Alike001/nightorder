import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hashTradeInstruction,
  type MarketQuote,
  type ToolResult,
  type TradePlan,
} from '@nightorder/domain';
import {
  SqlitePaperExecutionAdapter,
  type PaperExecutionOptions,
} from '../packages/execution/src/index.js';
import {
  IntegratedTradingRuntime,
  SqliteTradingPlanRepository,
  type RuntimeExecution,
} from '../packages/runtime/src/index.js';
import { SqliteArmedPlanStore } from '../apps/worker/src/armed-plans.js';
import type {
  DiagnosticModel,
  ModelInputItem,
  RecoveryToolName,
} from '../packages/agent/src/index.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const proofDirectory = join(repositoryRoot, 'evidence', 'runs');
const fixedNow = new Date('2026-10-10T12:00:00.000Z');

function makePlan(id: string, limitPrice = '60000'): TradePlan {
  const instruction = {
    id,
    ownerId: 'proof-owner',
    symbol: 'BTCUSDT' as const,
    side: 'BUY' as const,
    quoteBudgetUsdt: '500',
    triggerPrice: '60000',
    triggerOperator: 'ASK_LTE' as const,
    limitPrice,
    expiresAtUtc: '2026-10-10T13:00:00.000Z',
    timezone: 'UTC',
    mode: 'PAPER' as const,
  };
  return {
    ...instruction,
    planHash: hashTradeInstruction(instruction),
    state: 'DRAFT',
    revision: 0,
  };
}

async function approvedPlan(
  repository: SqliteTradingPlanRepository,
  plan: TradePlan,
): Promise<TradePlan> {
  await repository.createDraft(plan);
  const awaiting = await repository.saveTransition(
    { ...plan, state: 'AWAITING_CONFIRMATION', revision: 1 },
    0,
    '2026-10-10T11:58:00.000Z',
  );
  assert.equal(awaiting.ok, true);
  const armed = await repository.approveExactAtRevision(
    plan.id,
    plan.ownerId,
    plan.planHash,
    1,
    '2026-10-10T11:59:00.000Z',
  );
  assert.equal(armed.ok, true);
  if (!armed.ok) throw new Error(armed.message);
  return armed.data;
}

class QuoteFixture {
  constructor(private readonly quote: MarketQuote) {}

  async currentQuote(): Promise<ToolResult<MarketQuote>> {
    return {
      ok: true,
      data: this.quote,
      evidenceId: `fixture-quote-${this.quote.source}`,
    };
  }
}

class ScriptedProofModel implements DiagnosticModel {
  readonly selections: RecoveryToolName[] = [];
  private readonly script: (RecoveryToolName | 'finish')[] = [
    'read_attempt_journal',
    'query_order_by_client_id',
    'finish',
  ];

  async next(
    input: readonly ModelInputItem[],
    toolsEnabled: boolean,
  ): Promise<readonly Record<string, unknown>[]> {
    void input;
    void toolsEnabled;
    const next = this.script.shift() ?? 'finish';
    if (next === 'finish') return [{ type: 'message', content: [] }];
    this.selections.push(next);
    return [
      {
        type: 'function_call',
        call_id: `proof-call-${this.selections.length}`,
        name: next,
        arguments: '{}',
      },
    ];
  }
}

function fixtureQuote(ask: string): MarketQuote {
  return {
    symbol: 'BTCUSDT',
    bestBid: (Number(ask) - 1).toFixed(2),
    bestAsk: ask,
    observedAtUtc: fixedNow.toISOString(),
    receivedAtUtc: fixedNow.toISOString(),
    source: 'scripted-proof-fixture',
    kind: 'TEST_FIXTURE',
  };
}

function buildHarness(
  id: string,
  quote: MarketQuote,
  options: { limitPrice?: string; timeoutAfterCommit?: boolean } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'nightorder-runtime-proof-'));
  const repository = new SqliteTradingPlanRepository({
    databasePath: join(directory, 'plans.sqlite'),
    now: () => fixedNow,
  });
  const watcher = new SqliteArmedPlanStore(
    join(directory, 'watcher.sqlite'),
    () => fixedNow,
  );
  const selectedPlan = makePlan(id, options.limitPrice);
  const executionOptions: PaperExecutionOptions = {
    databasePath: join(directory, 'orders.sqlite'),
    initialBalances: { BTC: '0.25', USDT: '1000' },
    now: () => fixedNow,
  };
  const executionAdapter = new SqlitePaperExecutionAdapter(
    repository,
    executionOptions,
  );
  let timeoutInjected = false;
  const execution: RuntimeExecution = {
    mode: 'PAPER',
    virtualBalances: () => executionAdapter.virtualBalances(),
    submitApprovedOrder: async (request) => {
      const submitted = await executionAdapter.submitApprovedOrder(request);
      if (options.timeoutAfterCommit && !timeoutInjected && submitted.ok) {
        timeoutInjected = true;
        throw Object.assign(
          new Error('proof fixture: response lost after local commit'),
          { code: 'TIMEOUT' },
        );
      }
      return submitted;
    },
    findOrderByClientId: (clientOrderId) =>
      executionAdapter.findOrderByClientId(clientOrderId),
    requestCancel: (clientOrderId) =>
      executionAdapter.requestCancel(clientOrderId),
    loadVerificationEvidence: (planId) =>
      executionAdapter.loadVerificationEvidence(planId),
    getAttemptForPlan: (planId) => executionAdapter.getAttemptForPlan(planId),
    getOrderByClientId: (clientOrderId) =>
      executionAdapter.getOrderByClientId(clientOrderId),
    countOrdersForPlan: (planId) => executionAdapter.countOrdersForPlan(planId),
  };
  const traceEvents: string[] = [];
  const model = new ScriptedProofModel();
  const runtime = new IntegratedTradingRuntime({
    ownerId: selectedPlan.ownerId,
    plans: repository,
    watcher,
    market: new QuoteFixture(quote),
    execution,
    model,
    traces: { emit: (event) => traceEvents.push(event.name) },
    now: () => fixedNow,
    maxQuoteAgeMs: 5_000,
  });
  return {
    selectedPlan,
    repository,
    watcher,
    executionAdapter,
    runtime,
    model,
    traceEvents,
    cleanup: () => {
      executionAdapter.close();
      watcher.close();
      repository.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function writeProof(file: string, proof: Record<string, unknown>): void {
  mkdirSync(proofDirectory, { recursive: true });
  writeFileSync(
    join(proofDirectory, file),
    `${JSON.stringify({ generatedAtUtc: new Date().toISOString(), ...proof }, null, 2)}\n`,
  );
}

async function runAuthorizedTrigger(): Promise<void> {
  const harness = buildHarness('proof-a-authorized', fixtureQuote('59999.00'));
  try {
    const approved = await approvedPlan(
      harness.repository,
      harness.selectedPlan,
    );
    assert.equal(approved.state, 'ARMED');
    const runtimeResult = await harness.runtime.pollOnce();
    const persisted = await harness.repository.loadPlan(approved.id);
    const verification = await harness.executionAdapter
      .loadVerificationEvidence(approved.id)
      .then(async () =>
        new (
          await import('../packages/domain/src/verifier.js')
        ).PersistentRecordsVerifierAdapter(harness.executionAdapter).verify(
          approved.id,
        ),
      );
    assert.equal(persisted?.state, 'OPEN');
    assert.equal(verification.result, 'VERIFIED');
    assert.equal(harness.executionAdapter.countOrdersForPlan(approved.id), 1);
    const order = harness.executionAdapter.getOrderByClientId(
      `nightorder-${approved.id}`,
    );
    assert.equal(order?.status, 'NEW');
    assert.equal(order?.filledQuantity, '0');
    writeProof('run-a.json', {
      scenario: 'PERSISTED_APPROVAL_WATCHER_TRIGGER_GUARDED_PAPER_EXECUTION',
      result: 'PASS',
      quoteSource: 'TEST_FIXTURE',
      modelBehavior:
        'not used for deterministic execution; scripted quote fixture',
      runtimeResult,
      persistedPlanState: persisted?.state,
      persistedOrder: order,
      independentVerifier: verification,
      actualOrderCount: harness.executionAdapter.countOrdersForPlan(
        approved.id,
      ),
      neatlogs: 'not connected; in-memory runtime trace sink only',
    });
  } finally {
    harness.cleanup();
  }
}

async function runLimitRefusal(): Promise<void> {
  const harness = buildHarness(
    'proof-b-limit-refusal',
    fixtureQuote('59000.00'),
    { limitPrice: '58000' },
  );
  try {
    const approved = await approvedPlan(
      harness.repository,
      harness.selectedPlan,
    );
    const runtimeResult = await harness.runtime.pollOnce();
    const plan = await harness.repository.loadPlan(approved.id);
    assert.equal(plan?.state, 'TRIGGERED');
    assert.equal(harness.executionAdapter.countOrdersForPlan(approved.id), 0);
    assert.equal(await harness.repository.loadAttempt(approved.id), null);
    writeProof('run-b.json', {
      scenario: 'TRIGGER_CROSSED_OUTSIDE_APPROVED_LIMIT',
      result: 'PASS',
      quoteSource: 'TEST_FIXTURE',
      modelBehavior: 'not used; deterministic guard scenario',
      runtimeResult,
      persistedPlanState: plan?.state,
      actualOrderCount: harness.executionAdapter.countOrdersForPlan(
        approved.id,
      ),
      persistedAttempt: await harness.repository.loadAttempt(approved.id),
      neatlogs: 'not connected; in-memory runtime trace sink only',
    });
  } finally {
    harness.cleanup();
  }
}

async function runCommitThenTimeoutRecovery(): Promise<void> {
  const harness = buildHarness(
    'proof-c-commit-timeout',
    fixtureQuote('59999.00'),
    { timeoutAfterCommit: true },
  );
  try {
    const approved = await approvedPlan(
      harness.repository,
      harness.selectedPlan,
    );
    const runtimeResult = await harness.runtime.pollOnce();
    const plan = await harness.repository.loadPlan(approved.id);
    const order = harness.executionAdapter.getOrderByClientId(
      `nightorder-${approved.id}`,
    );
    const verification = await new (
      await import('../packages/domain/src/verifier.js')
    ).PersistentRecordsVerifierAdapter(harness.executionAdapter).verify(
      approved.id,
    );
    assert.equal(plan?.state, 'OPEN');
    assert.equal(order?.status, 'NEW');
    assert.equal(order?.filledQuantity, '0');
    assert.equal(verification.result, 'VERIFIED');
    assert.equal(harness.executionAdapter.countOrdersForPlan(approved.id), 1);
    writeProof('run-c.json', {
      scenario: 'PERSISTED_TRIGGER_COMMIT_THEN_TIMEOUT_RECOVERY',
      result: 'PASS',
      quoteSource: 'TEST_FIXTURE',
      injectedFailure:
        'scripted post-commit timeout fixture; no external venue call',
      modelBehavior:
        'SCRIPTED_MODEL_FIXTURE selects read-only diagnostics; not live model inference',
      selectedDiagnostics: harness.model.selections,
      runtimeResult,
      persistedPlanState: plan?.state,
      persistedOrder: order,
      independentVerifier: verification,
      actualOrderCount: harness.executionAdapter.countOrdersForPlan(
        approved.id,
      ),
      traceEvents: harness.traceEvents,
      neatlogs: 'not connected; in-memory events are not Neatlogs evidence',
    });
  } finally {
    harness.cleanup();
  }
}

async function main(): Promise<void> {
  await runAuthorizedTrigger();
  await runLimitRefusal();
  await runCommitThenTimeoutRecovery();
  const status = {
    generatedAtUtc: new Date().toISOString(),
    runs: ['run-a.json', 'run-b.json', 'run-c.json'],
    result: 'PASS',
    scope:
      'integrated SQLite plan, watcher, PAPER execution, recovery and persisted-evidence verification; test fixtures only',
    modelDrivenBehavior:
      'not exercised; recovery uses an explicitly scripted model fixture',
    notProvided: [
      'Telegram end-to-end flow',
      'live Gemini/model inference',
      'Neatlogs dashboard traces and before/after evaluation',
      'cfo.ai project/export',
      'demo video and public submission',
    ],
  };
  writeProof('proof-runner.json', status);
  console.log(JSON.stringify(status, null, 2));
}

void main().catch((cause: unknown) => {
  console.error(cause);
  process.exitCode = 1;
});
