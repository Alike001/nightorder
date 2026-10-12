import type {
  ExecutionPort,
  NeedsHumanEscalationRepository,
  OrderAttempt,
  PlanRepository,
  VerificationResult,
  VerificationPort,
} from '@nightorder/domain';
import {
  verificationCheckSchema,
  verificationResultSchema,
  verifyPersistentRecords,
} from '@nightorder/domain';

export type FailureCode = 'TIMEOUT' | 'NETWORK' | 'AMBIGUOUS';
export type RecoveryToolName =
  | 'read_attempt_journal'
  | 'query_order_by_client_id'
  | 'run_independent_verifier';

export interface RecoveryIncident {
  planId: string;
  operationId: string;
  clientOrderId: string;
  failureCode: FailureCode;
  occurredAtUtc: string;
}

export type RecoveryAttempt = OrderAttempt;

export interface DiagnosticPlanRepository
  extends
    NeedsHumanEscalationRepository,
    Pick<PlanRepository, 'loadAttempt' | 'recordObservation'> {
  loadAttempt(planId: string): Promise<RecoveryAttempt | null>;
  recordObservation(
    planId: string,
    event: Readonly<Record<string, unknown>>,
  ): Promise<void>;
}

export type DiagnosticExecutionPort = Pick<
  ExecutionPort,
  'findOrderByClientId'
>;

export type IndependentVerificationPort = VerificationPort;

export interface RecoveryTraceSink {
  emit(event: {
    name: string;
    attributes: Record<string, string | number | boolean>;
  }): void | Promise<void>;
}

export interface ModelInputItem {
  [key: string]: unknown;
}

export interface ModelOutputItem {
  [key: string]: unknown;
}

export interface DiagnosticModel {
  next(
    input: readonly ModelInputItem[],
    toolsEnabled: boolean,
  ): Promise<readonly ModelOutputItem[]>;
}

export interface RecoveryOptions {
  maxDiagnosticCalls?: number;
  now?: () => Date;
}

function verificationForModel(
  verification: VerificationResult,
): Record<string, unknown> {
  return {
    result: verification.result,
    checks: verification.checks,
    evidenceCount: verification.evidenceIds.length,
  };
}

function safeOrderStatus(status: string): string {
  return [
    'NEW',
    'PARTIALLY_FILLED',
    'FILLED',
    'CANCELED',
    'REJECTED',
    'EXPIRED',
  ].includes(status)
    ? status
    : 'UNKNOWN';
}

function safeErrorCode(code: string): string {
  return [
    'STALE_QUOTE',
    'EXPIRED',
    'UNAUTHORIZED',
    'INSUFFICIENT_BALANCE',
    'REJECTED',
    'TIMEOUT',
    'RATE_LIMIT',
    'NETWORK',
    'NOT_FOUND',
    'AMBIGUOUS',
  ].includes(code)
    ? code
    : 'DIAGNOSTIC_FAILED';
}

export interface RecoveryOutcome {
  result: VerificationResult['result'];
  needsHuman: boolean;
  escalationPersisted: boolean;
  tracingHealthy: boolean;
  diagnosticTools: RecoveryToolName[];
  checks: VerificationResult['checks'];
  evidenceIds: string[];
}

export class BoundedRecoveryAgent {
  private readonly maxDiagnosticCalls: number;
  private readonly now: () => Date;

  constructor(
    private readonly model: DiagnosticModel,
    private readonly repository: DiagnosticPlanRepository,
    private readonly execution: DiagnosticExecutionPort,
    private readonly verifier: IndependentVerificationPort,
    private readonly traces: RecoveryTraceSink,
    options: RecoveryOptions = {},
  ) {
    this.maxDiagnosticCalls = options.maxDiagnosticCalls ?? 3;
    if (
      !Number.isInteger(this.maxDiagnosticCalls) ||
      this.maxDiagnosticCalls < 1 ||
      this.maxDiagnosticCalls > 3
    ) {
      throw new Error('maxDiagnosticCalls must be an integer from 1 to 3');
    }
    this.now = options.now ?? (() => new Date());
  }

  async recover(incident: RecoveryIncident): Promise<RecoveryOutcome> {
    let tracingHealthy = true;
    const trace = async (
      name: string,
      attributes: Record<string, string | number | boolean>,
    ): Promise<void> => {
      try {
        await this.traces.emit({ name, attributes });
      } catch {
        tracingHealthy = false;
      }
    };
    const modelInput: ModelInputItem[] = [
      {
        role: 'user',
        content: JSON.stringify({
          kind: 'PAPER_ORDER_WRITE_FAILURE',
          planId: incident.planId,
          operationId: incident.operationId,
          failureCode: incident.failureCode,
          occurredAtUtc: incident.occurredAtUtc,
          instruction:
            'Investigate using only the available read-only diagnostics. Never submit, retry, cancel, or modify an order. Select one diagnostic tool at a time.',
        }),
      },
    ];
    const diagnosticTools: RecoveryToolName[] = [];
    const seenTools = new Set<RecoveryToolName>();
    let modelFailure = false;
    let protocolFailure = false;

    await trace('agent.recovery.started', {
      planId: incident.planId,
      operationId: incident.operationId,
      failureCode: incident.failureCode,
    });

    for (let turn = 0; turn <= this.maxDiagnosticCalls; turn += 1) {
      const toolsEnabled = diagnosticTools.length < this.maxDiagnosticCalls;
      let output: readonly ModelOutputItem[];
      try {
        output = await this.model.next(modelInput, toolsEnabled);
      } catch {
        modelFailure = true;
        await trace('agent.model.failed', {
          planId: incident.planId,
          reason: 'MODEL_UNAVAILABLE',
        });
        break;
      }
      modelInput.push(...output);

      const calls = output.filter((item) => item.type === 'function_call');
      if (calls.length === 0) break;
      if (!toolsEnabled || calls.length !== 1) {
        protocolFailure = true;
        await trace('agent.model.refused', {
          planId: incident.planId,
          reason: 'TOOL_CALL_BOUND_EXCEEDED',
        });
        break;
      }

      const call = calls[0];
      const name = this.parseToolName(call?.name);
      const callId = typeof call?.call_id === 'string' ? call.call_id : '';
      if (
        !name ||
        !callId ||
        !this.hasEmptyArguments(call?.arguments) ||
        seenTools.has(name)
      ) {
        protocolFailure = true;
        await trace('agent.model.refused', {
          planId: incident.planId,
          reason: 'INVALID_OR_REPEATED_TOOL_CALL',
        });
        break;
      }
      seenTools.add(name);
      diagnosticTools.push(name);
      await trace('agent.tool.selected', {
        planId: incident.planId,
        tool: name,
        step: diagnosticTools.length,
      });

      let result: Record<string, unknown>;
      try {
        result = await this.runDiagnostic(name, incident);
      } catch {
        result = { ok: false, code: 'DIAGNOSTIC_FAILED' };
      }
      try {
        await this.repository.recordObservation(incident.planId, {
          type: 'RECOVERY_DIAGNOSTIC',
          operationId: incident.operationId,
          tool: name,
          resultCode: result.ok === false ? result.code : 'READ_COMPLETE',
          occurredAtUtc: this.now().toISOString(),
        });
      } catch {
        protocolFailure = true;
        await trace('agent.recovery.journal_write_failed', {
          planId: incident.planId,
          reason: 'OBSERVATION_WRITE_FAILED',
        });
        break;
      }
      await trace('agent.tool.completed', {
        planId: incident.planId,
        tool: name,
        status: result.ok === false ? 'FAILED' : 'SUCCEEDED',
      });
      modelInput.push({
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(result),
      });
    }

    let verification: VerificationResult;
    try {
      verification = verificationResultSchema.parse(
        await this.verifier.verify(incident.planId),
      );
      const requiredChecks = verificationCheckSchema.options;
      if (
        Object.keys(verification.checks).length !== requiredChecks.length ||
        requiredChecks.some(
          (check) => !Object.hasOwn(verification.checks, check),
        )
      ) {
        throw new Error('Verifier did not return every domain check');
      }
    } catch {
      verification = verifyPersistentRecords(undefined);
    }
    await trace('agent.recovery.verified', {
      planId: incident.planId,
      result: verification.result,
      checksPassed: Object.values(verification.checks).filter(Boolean).length,
      checksTotal: Object.keys(verification.checks).length,
    });

    const allChecksPassed =
      Object.keys(verification.checks).length > 0 &&
      Object.values(verification.checks).every(Boolean);
    const success =
      !modelFailure &&
      !protocolFailure &&
      tracingHealthy &&
      diagnosticTools.length > 0 &&
      verification.result === 'VERIFIED' &&
      allChecksPassed;
    const result = success
      ? 'VERIFIED'
      : verification.result === 'BLOCKED'
        ? 'BLOCKED'
        : 'UNCERTAIN';

    if (!success) {
      const reasonCode = modelFailure
        ? 'MODEL_UNAVAILABLE'
        : !tracingHealthy
          ? 'TRACING_UNAVAILABLE'
          : protocolFailure
            ? 'MODEL_TOOL_PROTOCOL_FAILURE'
            : result === 'BLOCKED'
              ? 'VERIFICATION_BLOCKED'
              : 'RECOVERY_UNCERTAIN';
      let escalationPersisted = false;
      let escalationEvidenceIds: string[] = [];
      try {
        const escalation = await this.repository.markNeedsHuman(
          incident.planId,
          reasonCode,
        );
        if (escalation.ok) {
          escalationPersisted = true;
          escalationEvidenceIds = [escalation.evidenceId];
        } else {
          await trace('agent.recovery.escalation_write_failed', {
            planId: incident.planId,
            reasonCode: escalation.code,
          });
        }
      } catch {
        await trace('agent.recovery.escalation_write_failed', {
          planId: incident.planId,
          reasonCode: 'STATE_WRITE_FAILED',
        });
      }
      if (escalationPersisted) {
        try {
          await this.repository.recordObservation(incident.planId, {
            type: 'NEEDS_HUMAN',
            operationId: incident.operationId,
            reasonCode,
            occurredAtUtc: this.now().toISOString(),
          });
        } catch {
          await trace('agent.recovery.escalation_observation_failed', {
            planId: incident.planId,
            reasonCode: 'OBSERVATION_WRITE_FAILED',
          });
        }
      }
      await trace('agent.recovery.finished', {
        planId: incident.planId,
        result,
        needsHuman: true,
        escalationPersisted,
        tracingHealthy,
      });
      return {
        result,
        needsHuman: true,
        escalationPersisted,
        tracingHealthy,
        diagnosticTools,
        checks: verification.checks,
        evidenceIds: [
          ...new Set([...verification.evidenceIds, ...escalationEvidenceIds]),
        ],
      };
    }

    try {
      await this.repository.recordObservation(incident.planId, {
        type: 'RECOVERY_VERIFIED',
        operationId: incident.operationId,
        occurredAtUtc: this.now().toISOString(),
      });
    } catch {
      let escalationPersisted = false;
      let escalationEvidenceIds: string[] = [];
      try {
        const escalation = await this.repository.markNeedsHuman(
          incident.planId,
          'OBSERVATION_WRITE_FAILED',
        );
        if (escalation.ok) {
          escalationPersisted = true;
          escalationEvidenceIds = [escalation.evidenceId];
        } else {
          await trace('agent.recovery.escalation_write_failed', {
            planId: incident.planId,
            reasonCode: escalation.code,
          });
        }
      } catch {
        await trace('agent.recovery.escalation_write_failed', {
          planId: incident.planId,
          reasonCode: 'STATE_WRITE_FAILED',
        });
      }
      return {
        result: 'UNCERTAIN',
        needsHuman: true,
        escalationPersisted,
        tracingHealthy,
        diagnosticTools,
        checks: verification.checks,
        evidenceIds: [
          ...new Set([...verification.evidenceIds, ...escalationEvidenceIds]),
        ],
      };
    }
    await trace('agent.recovery.finished', {
      planId: incident.planId,
      result: 'VERIFIED',
      needsHuman: false,
      escalationPersisted: false,
      tracingHealthy,
    });
    return {
      result: 'VERIFIED',
      needsHuman: false,
      escalationPersisted: false,
      tracingHealthy,
      diagnosticTools,
      checks: verification.checks,
      evidenceIds: verification.evidenceIds,
    };
  }

  private async runDiagnostic(
    name: RecoveryToolName,
    incident: RecoveryIncident,
  ): Promise<Record<string, unknown>> {
    if (name === 'read_attempt_journal') {
      const attempt = await this.repository.loadAttempt(incident.planId);
      if (!attempt) return { ok: true, found: false };
      return {
        ok: true,
        found: true,
        state: attempt.state,
        venueStatus: attempt.venueStatus ?? null,
        evidenceSource: attempt.evidenceSource,
        requestDigestPresent: attempt.requestDigest.length > 0,
        operationMatches: attempt.operationId === incident.operationId,
        clientOrderMatches: attempt.clientOrderId === incident.clientOrderId,
      };
    }
    if (name === 'query_order_by_client_id') {
      const order = await this.execution.findOrderByClientId(
        incident.clientOrderId,
      );
      if (!order.ok) return { ok: false, code: safeErrorCode(order.code) };
      return {
        ok: true,
        found: true,
        orderId: order.data.orderId.slice(0, 128),
        status: safeOrderStatus(order.data.status),
        filledQuantity:
          /^\d+(?:\.\d+)?$/.test(order.data.filledQuantity) &&
          order.data.filledQuantity.length <= 80
            ? order.data.filledQuantity
            : 'INVALID',
      };
    }
    const verification = await this.verifier.verify(incident.planId);
    return { ok: true, ...verificationForModel(verification) };
  }

  private parseToolName(value: unknown): RecoveryToolName | null {
    if (
      value === 'read_attempt_journal' ||
      value === 'query_order_by_client_id' ||
      value === 'run_independent_verifier'
    ) {
      return value;
    }
    return null;
  }

  private hasEmptyArguments(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    try {
      const parsed: unknown = JSON.parse(value);
      return (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        Object.keys(parsed).length === 0
      );
    } catch {
      return false;
    }
  }
}

export interface ResponsesRequest {
  model: string;
  store: false;
  input: readonly ModelInputItem[];
  instructions: string;
  max_output_tokens: number;
  tools: readonly Record<string, unknown>[];
  parallel_tool_calls: false;
  tool_choice: 'auto' | 'none';
}

export interface ResponsesResult {
  output: ModelOutputItem[];
}

export interface ResponsesRequester {
  createResponse(request: ResponsesRequest): Promise<ResponsesResult>;
}

const toolDefinitions: readonly Record<string, unknown>[] = [
  {
    type: 'function',
    name: 'read_attempt_journal',
    description: 'Read the durable attempt journal for this incident plan.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'query_order_by_client_id',
    description:
      'Read the PAPER execution adapter by the incident client order ID.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'run_independent_verifier',
    description: 'Run independent read-only plan and order consistency checks.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
];

export class OpenAIResponsesDiagnosticModel implements DiagnosticModel {
  constructor(
    private readonly requester: ResponsesRequester,
    private readonly model: string,
    private readonly maxOutputTokens = 192,
  ) {
    if (!model.trim()) throw new Error('A diagnostic model name is required');
    if (
      !Number.isInteger(maxOutputTokens) ||
      maxOutputTokens < 32 ||
      maxOutputTokens > 512
    ) {
      throw new Error('maxOutputTokens must be an integer from 32 to 512');
    }
  }

  async next(
    input: readonly ModelInputItem[],
    toolsEnabled: boolean,
  ): Promise<readonly ModelOutputItem[]> {
    const response = await this.requester.createResponse({
      model: this.model,
      store: false,
      input,
      instructions:
        'You are a bounded NightOrder incident diagnostician. Select only read-only diagnostic functions when useful. Never request order submission, retry, cancellation, credentials, shell access, or any mutation. Do not infer success from an error message; base conclusions on tool evidence. Keep any final message brief.',
      max_output_tokens: this.maxOutputTokens,
      tools: toolsEnabled ? toolDefinitions : [],
      parallel_tool_calls: false,
      tool_choice: toolsEnabled ? 'auto' : 'none',
    });
    return response.output;
  }
}

export interface OpenAIResponsesClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

export class OpenAIResponsesHttpClient implements ResponsesRequester {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: OpenAIResponsesClientOptions) {
    if (!options.apiKey.trim()) throw new Error('OpenAI API key is required');
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(
      /\/+$/,
      '',
    );
    this.timeoutMs = options.timeoutMs ?? 8_000;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1_000 ||
      this.timeoutMs > 30_000
    ) {
      throw new Error('timeoutMs must be an integer from 1000 to 30000');
    }
    this.fetcher = options.fetcher ?? globalThis.fetch;
  }

  async createResponse(request: ResponsesRequest): Promise<ResponsesResult> {
    const response = await this.fetcher(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        `OpenAI Responses request failed with HTTP ${response.status}`,
      );
    }
    const body: unknown = await response.json();
    if (
      body === null ||
      typeof body !== 'object' ||
      !Array.isArray((body as { output?: unknown }).output)
    ) {
      throw new Error('OpenAI Responses response had no output array');
    }
    return { output: (body as { output: ModelOutputItem[] }).output };
  }
}

export function createDiagnosticModelFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  fetcher?: typeof fetch,
): DiagnosticModel {
  return {
    async next(input, toolsEnabled) {
      const apiKey = env.OPENAI_API_KEY;
      const model = env.NIGHTORDER_DIAGNOSTIC_MODEL;
      if (!apiKey)
        throw new Error(
          'OPENAI_API_KEY is required for live recovery diagnostics',
        );
      if (!model)
        throw new Error(
          'NIGHTORDER_DIAGNOSTIC_MODEL is required for live recovery diagnostics',
        );
      const requester = new OpenAIResponsesHttpClient(
        fetcher ? { apiKey, fetcher } : { apiKey },
      );
      return new OpenAIResponsesDiagnosticModel(requester, model).next(
        input,
        toolsEnabled,
      );
    },
  };
}
