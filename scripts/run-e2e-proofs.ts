import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SqlitePaperExecutionAdapter,
  type ApprovedPaperPlan,
  type PaperExecutionOptions,
  type PaperOrderRequest,
} from '../packages/execution/src/index.js';
import {
  BoundedRecoveryAgent,
  type DiagnosticModel,
  type ModelInputItem,
  type RecoveryIncident,
  type RecoveryToolName,
  type VerificationResult,
} from '../packages/agent/src/index.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const proofDirectory = join(repositoryRoot, 'evidence', 'runs');
const fixedNow = new Date('2026-10-10T12:00:00.000Z');

function plan(id: string): ApprovedPaperPlan {
  return {
    id,
    symbol: 'BTCUSDT',
    side: 'BUY',
    quoteBudgetUsdt: '500',
    limitPrice: '60000',
    expiresAtUtc: '2026-10-10T13:00:00.000Z',
    mode: 'PAPER',
    planHash: `fixture-digest-${id}`,
    approvedAtUtc: '2026-10-10T11:59:00.000Z',
    state: 'SUBMITTING',
  };
}

function request(planId: string, clientOrderId: string): PaperOrderRequest {
  return {
    clientOrderId,
    planId,
    symbol: 'BTCUSDT',
    side: 'BUY',
    quantity: '0.008',
    limitPrice: '60000',
  };
}

function createAdapter(selectedPlan: ApprovedPaperPlan) {
  const directory = mkdtempSync(join(tmpdir(), 'nightorder-e2e-'));
  const options: PaperExecutionOptions = {
    databasePath: join(directory, 'orders.sqlite'),
    initialBalances: { BTC: '0.25', USDT: '1000' },
    now: () => fixedNow,
  };
  const adapter = new SqlitePaperExecutionAdapter(
    {
      loadPlan: async (planId) =>
        planId === selectedPlan.id ? selectedPlan : null,
    },
    options,
  );
  return {
    adapter,
    cleanup: () => {
      adapter.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function verifyJournal(
  adapter: SqlitePaperExecutionAdapter,
  planId: string,
  clientOrderId: string,
): VerificationResult {
  // This readback runs after submission through separate query methods. It does
  // not trust the submit result or the model's description of what happened.
  const order = adapter.getOrderByClientId(clientOrderId);
  const attempt = adapter.getAttemptForPlan(planId);
  const checks = {
    orderMatchesClientId: order?.clientOrderId === clientOrderId,
    attemptMatchesOrder: Boolean(
      order && attempt && order.orderId === attempt.orderId,
    ),
    exactlyOneOrder: adapter.countOrdersForPlan(planId) === 1,
    acceptedIsNotFilled:
      order?.status === 'NEW' && order.filledQuantity === '0',
  };
  return {
    result: Object.values(checks).every(Boolean) ? 'VERIFIED' : 'UNCERTAIN',
    checks,
    evidenceIds: order ? [order.orderId] : [],
  };
}

function writeProof(file: string, proof: Record<string, unknown>): void {
  mkdirSync(proofDirectory, { recursive: true });
  writeFileSync(
    join(proofDirectory, file),
    `${JSON.stringify({ generatedAtUtc: new Date().toISOString(), ...proof }, null, 2)}\n`,
  );
}

async function runAuthorizedOrder(): Promise<void> {
  const selectedPlan = plan('proof-a-authorized');
  const clientOrderId = 'proof-a-client-order';
  const { adapter, cleanup } = createAdapter(selectedPlan);
  try {
    const submitted = await adapter.submitApprovedOrder(
      request(selectedPlan.id, clientOrderId),
    );
    assert.equal(submitted.ok, true);
    const verification = verifyJournal(adapter, selectedPlan.id, clientOrderId);
    assert.equal(verification.result, 'VERIFIED');
    writeProof('run-a.json', {
      scenario: 'PREAPPROVED_FIXTURE_PAPER_ORDER_READBACK',
      mode: 'PAPER',
      result: 'PASS',
      planSource: 'preapproved test fixture; no Telegram owner confirmation',
      submitStatus: submitted.ok ? submitted.data.status : 'REJECTED',
      verification,
      actualOrderCount: adapter.countOrdersForPlan(selectedPlan.id),
      model: 'not used for deterministic execution',
      neatlogs: 'not connected in this proof runner',
    });
  } finally {
    cleanup();
  }
}

async function runUnsafeRefusal(): Promise<void> {
  const selectedPlan = plan('proof-b-unsafe');
  const clientOrderId = 'proof-b-client-order';
  const { adapter, cleanup } = createAdapter(selectedPlan);
  try {
    const submitted = await adapter.submitApprovedOrder({
      ...request(selectedPlan.id, clientOrderId),
      limitPrice: '60000.01',
    });
    assert.equal(submitted.ok, false);
    if (submitted.ok) throw new Error('Unsafe order unexpectedly succeeded.');
    const balances = await adapter.virtualBalances();
    const checks = {
      guardRejected: submitted.code === 'REJECTED',
      noOrderWritten: adapter.countOrdersForPlan(selectedPlan.id) === 0,
      noAttemptWritten: adapter.getAttemptForPlan(selectedPlan.id) === null,
      balanceUnchanged:
        balances.ok &&
        balances.data.BTC === '0.25' &&
        balances.data.USDT === '1000',
    };
    assert.equal(Object.values(checks).every(Boolean), true);
    writeProof('run-b.json', {
      scenario: 'UNSAFE_LIMIT_REFUSAL',
      mode: 'PAPER',
      result: 'PASS',
      refusalCode: submitted.code,
      checks,
      actualOrderCount: adapter.countOrdersForPlan(selectedPlan.id),
      neatlogs: 'not connected in this proof runner',
    });
  } finally {
    cleanup();
  }
}

class ScriptedProofModel implements DiagnosticModel {
  readonly selections: RecoveryToolName[] = [];
  private readonly nextTools: (RecoveryToolName | 'finish')[] = [
    'read_attempt_journal',
    'query_order_by_client_id',
    'finish',
  ];

  async next(
    _input: readonly ModelInputItem[],
    _toolsEnabled: boolean,
  ): Promise<readonly Record<string, unknown>[]> {
    void _input;
    void _toolsEnabled;
    const tool = this.nextTools.shift() ?? 'finish';
    if (tool === 'finish') return [{ type: 'message', content: [] }];
    this.selections.push(tool);
    return [
      {
        type: 'function_call',
        call_id: `proof-call-${this.selections.length}`,
        name: tool,
        arguments: '{}',
      },
    ];
  }
}

async function runCommitThenTimeout(): Promise<void> {
  const selectedPlan = plan('proof-c-timeout');
  const orderRequest = request(selectedPlan.id, 'proof-c-client-order');
  const { adapter, cleanup } = createAdapter(selectedPlan);
  const traceEvents: string[] = [];
  const model = new ScriptedProofModel();
  const repository = {
    loadAttempt: async (planId: string) => adapter.getAttemptForPlan(planId),
    recordObservation: async () => undefined,
    markNeedsHuman: async () => undefined,
  };
  const verifier = {
    verify: async (planId: string) =>
      verifyJournal(adapter, planId, orderRequest.clientOrderId),
  };
  const recovery = new BoundedRecoveryAgent(
    model,
    repository,
    adapter,
    verifier,
    { emit: (event) => traceEvents.push(event.name) },
    { now: () => fixedNow },
  );
  const incident: RecoveryIncident = {
    planId: selectedPlan.id,
    operationId: `paper-order:${selectedPlan.id}`,
    clientOrderId: orderRequest.clientOrderId,
    failureCode: 'TIMEOUT',
    occurredAtUtc: fixedNow.toISOString(),
  };

  try {
    let injectedFailure = false;
    try {
      const committed = await adapter.submitApprovedOrder(orderRequest);
      assert.equal(committed.ok, true);
      // Inject a lost response after the durable SQLite commit.
      throw Object.assign(new Error('response lost after commit'), {
        code: 'TIMEOUT',
      });
    } catch (cause) {
      injectedFailure = (cause as { code?: string }).code === 'TIMEOUT';
    }
    assert.equal(injectedFailure, true);

    const outcome = await recovery.recover(incident);
    const readback = verifyJournal(
      adapter,
      selectedPlan.id,
      orderRequest.clientOrderId,
    );
    assert.equal(outcome.result, 'VERIFIED');
    assert.equal(readback.result, 'VERIFIED');
    assert.equal(adapter.countOrdersForPlan(selectedPlan.id), 1);
    assert.deepEqual(model.selections, [
      'read_attempt_journal',
      'query_order_by_client_id',
    ]);
    writeProof('run-c.json', {
      scenario: 'COMMIT_THEN_TIMEOUT_RECOVERY',
      mode: 'PAPER',
      result: 'PASS',
      injectedFailure:
        'TIMEOUT after SQLite commit; deterministic test fixture',
      model: 'scripted deterministic fixture; not a live model call',
      selectedDiagnostics: model.selections,
      recovery: outcome,
      independentReadback: readback,
      independentVerifier:
        'local journal readback; the standalone verifier package is not integrated',
      actualOrderCount: adapter.countOrdersForPlan(selectedPlan.id),
      inMemoryTraceEventNames: traceEvents,
      neatlogs: 'not connected; in-memory events are not Neatlogs evidence',
    });
  } finally {
    cleanup();
  }
}

async function main(): Promise<void> {
  await runAuthorizedOrder();
  await runUnsafeRefusal();
  await runCommitThenTimeout();
  const status = {
    generatedAtUtc: new Date().toISOString(),
    runs: ['run-a.json', 'run-b.json', 'run-c.json'],
    result: 'PASS',
    scope: 'local PAPER component integration using deterministic fixtures',
    notProvided: [
      'Telegram end-to-end flow',
      'live model inference',
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
