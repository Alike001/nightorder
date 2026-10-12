import {
  flush as neatlogsFlush,
  init as neatlogsInit,
  shutdown as neatlogsShutdown,
  trace as neatlogsTrace,
  type InitOptions,
  type TraceOptions,
} from 'neatlogs';
import {
  NoopTraceSink,
  type RuntimeTraceSink,
  type TraceAttributeValue,
  type TraceAttributes,
  type TraceSpanDefinition,
  type TraceSpanScope,
} from './contracts.js';

interface ActiveSpan {
  setAttribute(name: string, value: TraceAttributeValue): unknown;
}

export interface NeatlogsSdkBoundary {
  init(options: InitOptions): Promise<void>;
  trace<T>(
    options: TraceOptions,
    operation: (span: ActiveSpan) => T | Promise<T>,
  ): Promise<T>;
  flush(): Promise<boolean>;
  shutdown(reason?: string, timeoutMs?: number): Promise<boolean>;
}

const genuineSdk: NeatlogsSdkBoundary = {
  init: neatlogsInit,
  trace: neatlogsTrace,
  flush: neatlogsFlush,
  shutdown: neatlogsShutdown,
};

export interface NeatlogsRuntimeOptions {
  readonly apiKey?: string;
  readonly enabled?: boolean;
  readonly workflowName?: string;
  readonly endpoint?: string;
  readonly environment?: string;
  readonly telemetryFailure?: (
    phase: 'initialize' | 'record' | 'span' | 'flush' | 'shutdown',
  ) => void;
}

export type NeatlogsRuntimeState = 'READY' | 'DISABLED' | 'FAILED';

export interface NeatlogsRuntime {
  readonly state: NeatlogsRuntimeState;
  readonly sink: RuntimeTraceSink;
  flush(): Promise<boolean>;
  shutdown(): Promise<boolean>;
}

const forbiddenAttributeName =
  /(?:api.?key|authorization|credential|secret|token|telegram.?text|conversation|prompt|reasoning)/i;
const secretValue =
  /(?:\bBearer\s+[A-Za-z0-9._~+/-]+=*|\bsk-[A-Za-z0-9_-]{8,})/i;

function notifyFailure(
  callback: NeatlogsRuntimeOptions['telemetryFailure'],
  phase: 'initialize' | 'record' | 'span' | 'flush' | 'shutdown',
): void {
  try {
    callback?.(phase);
  } catch {
    // Telemetry diagnostics must not become an application dependency.
  }
}

function safeAttribute(
  name: string,
  value: TraceAttributeValue,
): TraceAttributeValue | undefined {
  if (forbiddenAttributeName.test(name)) return undefined;
  if (typeof value !== 'string') return value;
  if (secretValue.test(value)) return '[REDACTED]';
  return value.replace(/[\r\n]+/g, ' ').slice(0, 256);
}

export function sanitizeTraceAttributes(
  attributes: TraceAttributes = {},
): Record<string, TraceAttributeValue> {
  const sanitized: Record<string, TraceAttributeValue> = {};
  for (const [name, value] of Object.entries(attributes)) {
    const safe = safeAttribute(name, value);
    if (safe !== undefined) sanitized[name.slice(0, 128)] = safe;
  }
  return sanitized;
}

function maskTelemetryValue(value: unknown, key = ''): unknown {
  if (forbiddenAttributeName.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    return secretValue.test(value) ? '[REDACTED]' : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => maskTelemetryValue(entry));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        maskTelemetryValue(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

export function nightOrderTelemetryMask(
  telemetry: Record<string, unknown>,
): Record<string, unknown> {
  return maskTelemetryValue(telemetry) as Record<string, unknown>;
}

export class NeatlogsTraceSink implements RuntimeTraceSink {
  constructor(
    private readonly sdk: NeatlogsSdkBoundary,
    private readonly telemetryFailure?: NeatlogsRuntimeOptions['telemetryFailure'],
  ) {}

  async record(definition: TraceSpanDefinition): Promise<void> {
    try {
      await this.sdk.trace(this.options(definition), (span) => {
        this.applyAttributes(span, definition);
      });
    } catch {
      notifyFailure(this.telemetryFailure, 'record');
    }
  }

  async runSpan<T>(
    definition: TraceSpanDefinition,
    operation: (scope: TraceSpanScope) => Promise<T>,
  ): Promise<T> {
    let operationStarted = false;
    let operationSucceeded = false;
    let operationResult: T | undefined;
    let operationFailure: unknown;

    try {
      await this.sdk.trace<void>(this.options(definition), async (span) => {
        this.applyAttributes(span, definition);
        const scope: TraceSpanScope = {
          setAttribute: (name, value) => {
            const safe = safeAttribute(name, value);
            if (safe === undefined) return;
            try {
              span.setAttribute(name.slice(0, 128), safe);
            } catch {
              notifyFailure(this.telemetryFailure, 'span');
            }
          },
        };
        operationStarted = true;
        try {
          operationResult = await operation(scope);
          operationSucceeded = true;
        } catch (error) {
          operationFailure = error;
          scope.setAttribute('business_operation_failed', true);
        }
      });
    } catch (error) {
      if (operationFailure !== undefined) throw operationFailure;
      notifyFailure(this.telemetryFailure, 'span');
      if (!operationStarted) return operation({ setAttribute() {} });
      if (operationSucceeded) return operationResult as T;
      throw error;
    }
    if (!operationStarted) {
      notifyFailure(this.telemetryFailure, 'span');
      return operation({ setAttribute() {} });
    }
    if (operationFailure !== undefined) throw operationFailure;
    return operationResult as T;
  }

  private options(definition: TraceSpanDefinition): TraceOptions {
    const attributes = sanitizeTraceAttributes({
      ...(definition.attributes ?? {}),
      nightorder_run_id: definition.runId,
      ...(definition.pseudonymousPlanId === undefined
        ? {}
        : { nightorder_plan_id: definition.pseudonymousPlanId }),
      ...(definition.atUtc === undefined
        ? {}
        : { nightorder_event_at_utc: definition.atUtc }),
    });
    return {
      name: definition.name,
      kind: definition.kind,
      ...(definition.kind === 'WORKFLOW'
        ? {
            sessionId: definition.runId,
            sessionFeatureName: definition.name,
            sessionEntryPoint: 'nightorder',
          }
        : {}),
      attributes,
    };
  }

  private applyAttributes(
    span: ActiveSpan,
    definition: TraceSpanDefinition,
  ): void {
    for (const [name, value] of Object.entries(
      this.options(definition).attributes ?? {},
    )) {
      try {
        span.setAttribute(name, value as TraceAttributeValue);
      } catch {
        notifyFailure(this.telemetryFailure, 'span');
      }
    }
    if (definition.kind === 'TOOL') {
      try {
        span.setAttribute(
          'neatlogs.tool.name',
          definition.attributes?.tool_name ?? definition.name,
        );
      } catch {
        notifyFailure(this.telemetryFailure, 'span');
      }
    }
    if (definition.kind === 'GUARDRAIL') {
      const passed = definition.attributes?.passed;
      if (typeof passed === 'boolean') {
        try {
          span.setAttribute('neatlogs.guardrail.passed', passed);
        } catch {
          notifyFailure(this.telemetryFailure, 'span');
        }
      }
    }
  }
}

/** Structurally implements TelegramTraceSink without coupling package ownership. */
export class NeatlogsTelegramTraceSink extends NeatlogsTraceSink {}

export async function initializeNeatlogs(
  options: NeatlogsRuntimeOptions,
  sdk: NeatlogsSdkBoundary = genuineSdk,
): Promise<NeatlogsRuntime> {
  const enabled = options.enabled ?? true;
  const apiKey = options.apiKey?.trim();
  if (!enabled || !apiKey) return disabledRuntime('DISABLED');

  try {
    await sdk.init({
      apiKey,
      workflowName: options.workflowName ?? 'nightorder',
      ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
      tags: ['nightorder', 'paper-only'],
      metadata: {
        mode: 'PAPER',
        ...(options.environment === undefined
          ? {}
          : { environment: options.environment }),
      },
      captureLogs: false,
      registerShutdownHandlers: false,
      mask: nightOrderTelemetryMask,
    });
  } catch {
    notifyFailure(options.telemetryFailure, 'initialize');
    return disabledRuntime('FAILED');
  }

  const sink = new NeatlogsTelegramTraceSink(sdk, options.telemetryFailure);
  let stopped = false;
  let shutdownPromise: Promise<boolean> | undefined;
  return {
    state: 'READY',
    sink,
    async flush() {
      if (stopped) return true;
      try {
        const success = await sdk.flush();
        if (!success) notifyFailure(options.telemetryFailure, 'flush');
        return success;
      } catch {
        notifyFailure(options.telemetryFailure, 'flush');
        return false;
      }
    },
    async shutdown() {
      if (shutdownPromise) return shutdownPromise;
      stopped = true;
      shutdownPromise = (async () => {
        let flushed = false;
        let shutDown = false;
        try {
          flushed = await sdk.flush();
          if (!flushed) notifyFailure(options.telemetryFailure, 'flush');
        } catch {
          notifyFailure(options.telemetryFailure, 'flush');
        }
        try {
          shutDown = await sdk.shutdown('nightorder_graceful_shutdown');
          if (!shutDown) notifyFailure(options.telemetryFailure, 'shutdown');
        } catch {
          notifyFailure(options.telemetryFailure, 'shutdown');
        }
        return flushed && shutDown;
      })();
      return shutdownPromise;
    },
  };
}

export async function initializeNeatlogsFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  telemetryFailure?: NeatlogsRuntimeOptions['telemetryFailure'],
): Promise<NeatlogsRuntime> {
  return initializeNeatlogs({
    ...(env.NEATLOGS_API_KEY === undefined
      ? {}
      : { apiKey: env.NEATLOGS_API_KEY }),
    enabled: env.NEATLOGS_ENABLED !== 'false',
    workflowName: env.NEATLOGS_WORKFLOW_NAME ?? 'nightorder',
    ...(env.NEATLOGS_ENDPOINT === undefined
      ? {}
      : { endpoint: env.NEATLOGS_ENDPOINT }),
    ...(env.NODE_ENV === undefined ? {} : { environment: env.NODE_ENV }),
    ...(telemetryFailure === undefined ? {} : { telemetryFailure }),
  });
}

function disabledRuntime(state: 'DISABLED' | 'FAILED'): NeatlogsRuntime {
  return {
    state,
    sink: new NoopTraceSink(),
    async flush() {
      return true;
    },
    async shutdown() {
      return true;
    },
  };
}
