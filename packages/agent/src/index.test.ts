import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hashTradeInstruction,
  needsHumanEscalationSchema,
  needsHumanIdempotencyKey,
  PersistentRecordsVerifierAdapter,
  type NeedsHumanEscalation,
  type NeedsHumanReasonCode,
  type ToolResult,
  type VerificationPort,
} from '@nightorder/domain';
import {
  type ApprovedPaperPlan,
  type PaperExecutionOptions,
  type PaperOrderRequest,
  SqlitePaperExecutionAdapter,
} from '@nightorder/execution';
import {
  BoundedRecoveryAgent,
  createDiagnosticModelFromEnvironment,
  OpenAIResponsesDiagnosticModel,
  OpenAIResponsesHttpClient,
  type DiagnosticModel,
  type ModelInputItem,
  type RecoveryIncident,
  type RecoveryToolName,
  type ResponsesRequest,
} from './index.js';

const instruction = {
  id: 'recovery-plan-1',
  ownerId: 'recovery-owner-1',
  symbol: 'BTCUSDT',
  side: 'BUY',
  quoteBudgetUsdt: '500',
  triggerPrice: '59000',
  triggerOperator: 'ASK_LTE',
  limitPrice: '60000',
  expiresAtUtc: '2026-10-10T13:00:00.000Z',
  timezone: 'UTC',
  mode: 'PAPER',
} as const;
const plan: ApprovedPaperPlan = {
  ...instruction,
  planHash: hashTradeInstruction(instruction),
  approvedAtUtc: '2026-10-10T11:59:00.000Z',
  state: 'SUBMITTING',
  revision: 2,
};

const orderRequest: PaperOrderRequest = {
  clientOrderId: 'nightorder-recovery-plan-1',
  planId: plan.id,
  symbol: 'BTCUSDT',
  side: 'BUY',
  quantity: '0.008',
  limitPrice: '60000',
};

const incident: RecoveryIncident = {
  planId: plan.id,
  operationId: `paper-order:${plan.id}`,
  clientOrderId: orderRequest.clientOrderId,
  failureCode: 'TIMEOUT',
  occurredAtUtc: '2026-10-10T12:00:00.000Z',
};

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class ScriptedModel implements DiagnosticModel {
  readonly selections: RecoveryToolName[] = [];
  readonly toolsEnabled: boolean[] = [];
  private readonly script: (RecoveryToolName | 'finish')[];

  constructor(script: readonly (RecoveryToolName | 'finish')[]) {
    this.script = [...script];
  }

  async next(_input: readonly ModelInputItem[], toolsEnabled: boolean) {
    this.toolsEnabled.push(toolsEnabled);
    const action = this.script.shift();
    const nextAction = action ?? 'finish';
    if (nextAction === 'finish') {
      return [{ type: 'message', content: [] }];
    }
    this.selections.push(nextAction);
    return [
      {
        type: 'function_call',
        call_id: `call-${this.selections.length}`,
        name: nextAction,
        arguments: '{}',
      },
    ];
  }
}

interface Harness {
  adapter: SqlitePaperExecutionAdapter;
  repository: {
    loadAttempt: (
      planId: string,
    ) => Promise<ReturnType<SqlitePaperExecutionAdapter['getAttemptForPlan']>>;
    recordObservation: (
      planId: string,
      event: Record<string, unknown>,
    ) => Promise<void>;
    markNeedsHuman: (
      planId: string,
      reasonCode: NeedsHumanReasonCode,
    ) => Promise<ToolResult<NeedsHumanEscalation>>;
  };
  traces: Array<{
    name: string;
    attributes: Record<string, string | number | boolean>;
  }>;
  marked: Array<{ planId: string; reasonCode: NeedsHumanReasonCode }>;
  observations: Array<{ planId: string; event: Record<string, unknown> }>;
  close: () => void;
}

function createHarness(
  selectedPlan = plan,
  authorizationOwnerId = selectedPlan.ownerId,
  escalationWriteSucceeds = true,
): Harness {
  const directory = mkdtempSync(join(tmpdir(), 'nightorder-recovery-'));
  directories.push(directory);
  const options: PaperExecutionOptions = {
    databasePath: join(directory, 'orders.sqlite'),
    initialBalances: { BTC: '0.25', USDT: '1000' },
    now: () => new Date('2026-10-10T12:00:00.000Z'),
  };
  const adapter = new SqlitePaperExecutionAdapter(
    {
      loadPlan: async (planId) =>
        planId === selectedPlan.id ? selectedPlan : null,
      loadPlanEvidence: async () => ({
        evidenceId: 'persisted-plan-evidence',
        data: selectedPlan,
      }),
      loadAuthorizationEvidence: async () => ({
        evidenceId: 'persisted-authorization-evidence',
        data: {
          planId: selectedPlan.id,
          ownerId: authorizationOwnerId,
          planHash: selectedPlan.planHash,
          approvedAtUtc: selectedPlan.approvedAtUtc!,
        },
      }),
    },
    options,
  );
  const traces: Harness['traces'] = [];
  const marked: Harness['marked'] = [];
  const observations: Harness['observations'] = [];
  const repository: Harness['repository'] = {
    loadAttempt: async (planId) => adapter.getAttemptForPlan(planId),
    recordObservation: async (planId, event) => {
      observations.push({ planId, event });
    },
    markNeedsHuman: async (planId, reasonCode) => {
      marked.push({ planId, reasonCode });
      if (!escalationWriteSucceeds) {
        return {
          ok: false,
          code: 'PERSISTENCE_FAILED',
          message: 'Fixture escalation persistence failed.',
          retrySafe: false,
          evidenceId: 'failed-escalation-write',
        };
      }
      return {
        ok: true,
        data: needsHumanEscalationSchema.parse({
          id: 'escalation-row-1',
          planId,
          reasonCode,
          idempotencyKey: needsHumanIdempotencyKey(planId, reasonCode),
          status: 'OPEN',
          planStateAtEscalation: selectedPlan.state,
          planRevisionAtEscalation: selectedPlan.revision,
          createdAtUtc: '2026-10-10T12:00:01.000Z',
        }),
        evidenceId: 'escalation-evidence-1',
      };
    },
  };
  return {
    adapter,
    repository,
    traces,
    marked,
    observations,
    close: () => adapter.close(),
  };
}

function createVerifier(harness: Harness) {
  return new PersistentRecordsVerifierAdapter(harness.adapter);
}

function makeAgent(
  harness: Harness,
  model: DiagnosticModel,
  maxDiagnosticCalls = 3,
) {
  return new BoundedRecoveryAgent(
    model,
    harness.repository,
    harness.adapter,
    createVerifier(harness),
    {
      emit: (event) => {
        harness.traces.push(event);
      },
    },
    {
      maxDiagnosticCalls,
      now: () => new Date('2026-10-10T12:00:01.000Z'),
    },
  );
}

async function commitThenTimeout(harness: Harness): Promise<RecoveryIncident> {
  const committed = await harness.adapter.submitApprovedOrder(orderRequest);
  if (!committed.ok) throw new Error('fixture paper submission did not commit');
  // The timeout is injected after the real SQLite write, exactly at the caller boundary.
  throw Object.assign(new Error('paper response was lost after commit'), {
    code: 'TIMEOUT',
  });
}

describe('bounded model-led order recovery', () => {
  it('lets the model select journal and adapter readback after a commit-then-timeout', async () => {
    const harness = createHarness();
    try {
      try {
        await commitThenTimeout(harness);
      } catch (cause) {
        expect(cause).toMatchObject({ code: 'TIMEOUT' });
      }
      const model = new ScriptedModel([
        'read_attempt_journal',
        'query_order_by_client_id',
        'finish',
      ]);
      const result = await makeAgent(harness, model).recover(incident);
      expect(result).toMatchObject({
        result: 'VERIFIED',
        needsHuman: false,
        escalationPersisted: false,
        diagnosticTools: ['read_attempt_journal', 'query_order_by_client_id'],
      });
      expect(model.toolsEnabled).toEqual([true, true, true]);
      expect(harness.adapter.countOrdersForPlan(plan.id)).toBe(1);
      expect(harness.adapter.getAttemptForPlan(plan.id)?.state).toBe(
        'ACKNOWLEDGED',
      );
      expect(harness.marked).toHaveLength(0);
      expect(harness.traces.map((event) => event.name)).toContain(
        'agent.tool.selected',
      );
    } finally {
      harness.close();
    }
  });

  it('moves unresolved timeouts to NEEDS_HUMAN without retrying or submitting', async () => {
    const harness = createHarness();
    try {
      const model = new ScriptedModel([
        'read_attempt_journal',
        'query_order_by_client_id',
        'finish',
      ]);
      const result = await makeAgent(harness, model).recover(incident);
      expect(result).toMatchObject({
        result: 'UNCERTAIN',
        needsHuman: true,
        escalationPersisted: true,
      });
      expect(harness.marked).toEqual([
        { planId: plan.id, reasonCode: 'RECOVERY_UNCERTAIN' },
      ]);
      expect(harness.adapter.countOrdersForPlan(plan.id)).toBe(0);
      expect(model.selections).not.toContain('submit_order');
    } finally {
      harness.close();
    }
  });

  it('does not claim escalation persistence when the durable port rejects the write', async () => {
    const harness = createHarness(plan, plan.ownerId, false);
    try {
      const model = new ScriptedModel(['finish']);
      const result = await makeAgent(harness, model).recover(incident);
      expect(result).toMatchObject({
        result: 'UNCERTAIN',
        needsHuman: true,
        escalationPersisted: false,
      });
      expect(result.evidenceIds).not.toContain('failed-escalation-write');
    } finally {
      harness.close();
    }
  });

  it('blocks duplicate evidence and persists a human escalation', async () => {
    const harness = createHarness(plan, 'different-owner');
    try {
      const submitted = await harness.adapter.submitApprovedOrder(orderRequest);
      expect(submitted.ok).toBe(true);
      const model = new ScriptedModel(['read_attempt_journal', 'finish']);
      const result = await makeAgent(harness, model).recover(incident);
      expect(result.result).toBe('BLOCKED');
      expect(result.needsHuman).toBe(true);
      expect(harness.marked[0]?.reasonCode).toBe('VERIFICATION_BLOCKED');
    } finally {
      harness.close();
    }
  });

  it('rejects incomplete verifier output instead of accepting or filling its missing checks', async () => {
    const harness = createHarness();
    try {
      const partialVerifier = {
        verify: async () => ({
          result: 'VERIFIED',
          checks: { PLAN_HASH_MATCHES: true },
          evidenceIds: ['unpersisted-evidence'],
        }),
      } as unknown as VerificationPort;
      const agent = new BoundedRecoveryAgent(
        new ScriptedModel(['read_attempt_journal', 'finish']),
        harness.repository,
        harness.adapter,
        partialVerifier,
        { emit: () => undefined },
      );
      const result = await agent.recover(incident);
      expect(result.result).toBe('UNCERTAIN');
      expect(result.evidenceIds).toEqual(['escalation-evidence-1']);
      expect(Object.keys(result.checks)).toHaveLength(9);
      expect(Object.values(result.checks).every((check) => !check)).toBe(true);
    } finally {
      harness.close();
    }
  });

  it('refuses unknown or mutation tool calls and respects the diagnostic cap', async () => {
    const harness = createHarness();
    try {
      const mutationModel: DiagnosticModel = {
        async next() {
          return [
            {
              type: 'function_call',
              call_id: 'unsafe-call',
              name: 'submit_order',
              arguments: '{}',
            },
          ];
        },
      };
      const denied = await makeAgent(harness, mutationModel).recover(incident);
      expect(denied.result).toBe('UNCERTAIN');
      expect(denied.diagnosticTools).toEqual([]);
      expect(harness.adapter.countOrdersForPlan(plan.id)).toBe(0);
      expect(harness.marked).toHaveLength(1);
    } finally {
      harness.close();
    }

    const capped = createHarness();
    try {
      const model = new ScriptedModel([
        'read_attempt_journal',
        'query_order_by_client_id',
        'finish',
      ]);
      const result = await makeAgent(capped, model, 1).recover(incident);
      expect(result.needsHuman).toBe(true);
      expect(model.toolsEnabled).toEqual([true, false]);
      expect(capped.marked[0]?.reasonCode).toBe('MODEL_TOOL_PROTOCOL_FAILURE');
    } finally {
      capped.close();
    }
  });

  it('uses strict, single-tool, stateless Responses API requests with bounded output', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      return new Response(
        JSON.stringify({
          output: [
            {
              type: 'function_call',
              call_id: 'call-1',
              name: 'read_attempt_journal',
              arguments: '{}',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const client = new OpenAIResponsesHttpClient({
      apiKey: 'fixture-only-key',
      fetcher,
    });
    const model = new OpenAIResponsesDiagnosticModel(
      client,
      'fixture-model',
      128,
    );
    const output = await model.next(
      [{ role: 'user', content: 'timeout' }],
      true,
    );
    expect(output[0]).toMatchObject({
      type: 'function_call',
      name: 'read_attempt_journal',
    });
    const request = requests[0];
    expect(request?.url).toBe('https://api.openai.com/v1/responses');
    expect(request?.init.headers).toMatchObject({
      authorization: 'Bearer fixture-only-key',
    });
    const body = JSON.parse(String(request?.init.body)) as ResponsesRequest;
    expect(body).toMatchObject({
      model: 'fixture-model',
      store: false,
      max_output_tokens: 128,
      parallel_tool_calls: false,
      tool_choice: 'auto',
    });
    expect(body.tools).toHaveLength(3);
    expect(body.tools.every((tool) => tool.strict === true)).toBe(true);
    expect(body.tools.some((tool) => tool.name === 'submit_order')).toBe(false);
  });

  it('fails closed when live model configuration is absent', async () => {
    const harness = createHarness();
    try {
      const model = createDiagnosticModelFromEnvironment({});
      const result = await makeAgent(harness, model).recover(incident);
      expect(result).toMatchObject({ result: 'UNCERTAIN', needsHuman: true });
      expect(harness.marked[0]?.reasonCode).toBe('MODEL_UNAVAILABLE');
    } finally {
      harness.close();
    }
  });
});
