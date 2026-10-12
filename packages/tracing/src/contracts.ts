import { createHash, randomUUID } from 'node:crypto';

export type NightOrderSpanKind = 'WORKFLOW' | 'AGENT' | 'TOOL' | 'GUARDRAIL';

export type TraceAttributeValue = string | number | boolean;
export type TraceAttributes = Readonly<Record<string, TraceAttributeValue>>;

export interface TraceContext {
  /** Application correlation ID. This is not a Neatlogs trace ID. */
  readonly runId: string;
  readonly pseudonymousPlanId?: string;
}

export interface TraceSpanDefinition extends TraceContext {
  readonly name: string;
  readonly kind: NightOrderSpanKind;
  readonly atUtc?: string;
  readonly attributes?: TraceAttributes;
}

export interface TraceSpanScope {
  setAttribute(name: string, value: TraceAttributeValue): void;
}

export interface RuntimeTraceSink {
  record(span: TraceSpanDefinition): Promise<void> | void;
  runSpan<T>(
    span: TraceSpanDefinition,
    operation: (scope: TraceSpanScope) => Promise<T>,
  ): Promise<T>;
}

/** Structural sink aliases teammates can consume without changing this package. */
export type MarketWatcherTraceSink = RuntimeTraceSink;
export type RecoveryAgentTraceSink = RuntimeTraceSink;
export type IndependentVerifierTraceSink = RuntimeTraceSink;

export function generateRunId(): string {
  return randomUUID();
}

/** One-way, deterministic correlation label; never emit the source plan ID. */
export function pseudonymizePlanId(planId: string): string {
  return `plan_${createHash('sha256')
    .update(`nightorder:plan:${planId}`, 'utf8')
    .digest('hex')
    .slice(0, 24)}`;
}

export class NoopTraceSink implements RuntimeTraceSink {
  record(): void {}

  async runSpan<T>(
    _span: TraceSpanDefinition,
    operation: (scope: TraceSpanScope) => Promise<T>,
  ): Promise<T> {
    return operation({ setAttribute() {} });
  }
}

export function watcherWorkflowSpan(
  context: TraceContext,
  attributes: TraceAttributes = {},
): TraceSpanDefinition {
  return {
    ...context,
    name: 'market_watcher.evaluate_plan',
    kind: 'WORKFLOW',
    attributes,
  };
}

export function watcherGuardrailSpan(
  context: TraceContext,
  attributes: TraceAttributes,
): TraceSpanDefinition {
  return {
    ...context,
    name: 'market_watcher.execution_guard',
    kind: 'GUARDRAIL',
    attributes,
  };
}

export function recoveryAgentSpan(
  context: TraceContext,
  attributes: TraceAttributes = {},
): TraceSpanDefinition {
  return {
    ...context,
    name: 'recovery.investigate_incident',
    kind: 'AGENT',
    attributes,
  };
}

export function recoveryToolSpan(
  context: TraceContext,
  toolName: string,
  attributes: TraceAttributes = {},
): TraceSpanDefinition {
  return {
    ...context,
    name: `recovery.tool.${toolName}`,
    kind: 'TOOL',
    attributes: { ...attributes, tool_name: toolName },
  };
}

export function verifierWorkflowSpan(
  context: TraceContext,
  attributes: TraceAttributes = {},
): TraceSpanDefinition {
  return {
    ...context,
    name: 'verifier.verify_persistent_records',
    kind: 'WORKFLOW',
    attributes,
  };
}

export function verifierGuardrailSpan(
  context: TraceContext,
  checkName: string,
  passed: boolean,
): TraceSpanDefinition {
  return {
    ...context,
    name: `verifier.check.${checkName.toLowerCase()}`,
    kind: 'GUARDRAIL',
    attributes: { check_name: checkName, passed },
  };
}
