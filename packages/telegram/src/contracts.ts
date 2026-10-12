import type {
  OrderAttempt,
  PlanRepository,
  ToolResult,
  TradePlan,
} from '@nightorder/domain';
import { stableIdSchema, utcTimestampSchema } from '@nightorder/domain';
import type { NightOrderSpanKind, TraceSpanScope } from '@nightorder/tracing';
import { z } from 'zod';

export const telegramMessageSchema = z
  .object({
    updateId: stableIdSchema,
    chatId: stableIdSchema,
    userId: stableIdSchema,
    text: z.string().trim().min(1).max(4_096),
  })
  .strict();

export const instructionProposalSchema = z
  .object({
    asset: z.string().trim().min(1).nullable(),
    side: z.enum(['BUY', 'SELL']).nullable(),
    quoteBudgetUsdt: z.string().trim().min(1).nullable(),
    baseQuantityBtc: z.string().trim().min(1).nullable(),
    triggerPrice: z.string().trim().min(1).nullable(),
    triggerOperator: z.enum(['ASK_LTE', 'BID_GTE']).nullable(),
    limitPrice: z.string().trim().min(1).nullable(),
    expiresAtUtc: z.string().trim().min(1).nullable(),
    timezone: z.string().trim().min(1).nullable(),
  })
  .strict();

export const clarificationFieldSchema = z.enum([
  'ASSET',
  'DIRECTION',
  'AMOUNT',
  'PRICE_CONDITION',
  'EXECUTION_LIMIT',
  'EXPIRY',
]);

export const telegramReplyKindSchema = z.enum([
  'INFO',
  'CLARIFICATION',
  'PREVIEW',
  'APPROVED',
  'STATUS',
  'CANCELLATION',
  'ERROR',
]);

export const telegramReplySchema = z
  .object({
    chatId: stableIdSchema,
    kind: telegramReplyKindSchema,
    text: z.string().min(1),
  })
  .strict();

export type TelegramMessage = z.infer<typeof telegramMessageSchema>;
export type InstructionProposal = z.infer<typeof instructionProposalSchema>;
export type ClarificationField = z.infer<typeof clarificationFieldSchema>;
export type TelegramReplyKind = z.infer<typeof telegramReplyKindSchema>;
export type TelegramReply = z.infer<typeof telegramReplySchema>;

export interface InterpretationContext {
  readonly nowUtc: string;
  readonly messages: readonly string[];
}

export interface InstructionInterpreter {
  interpret(context: InterpretationContext): Promise<InstructionProposal>;
}

export interface TelegramPlanRepository extends Omit<
  PlanRepository,
  'markNeedsHuman'
> {
  listPlansByOwner(ownerId: string): Promise<readonly TradePlan[]>;
  saveTransition(
    plan: TradePlan,
    expectedRevision: number,
    transitionedAtUtc: string,
  ): Promise<ToolResult<TradePlan>>;
  approveExactAtRevision(
    planId: string,
    ownerId: string,
    expectedHash: string,
    expectedRevision: number,
    approvedAtUtc: string,
  ): Promise<ToolResult<TradePlan>>;
  cancelOwnedAtRevision(
    planId: string,
    ownerId: string,
    expectedRevision: number,
    requestedAtUtc: string,
  ): Promise<ToolResult<TradePlan>>;
}

export interface TelegramTraceEvent {
  readonly name: string;
  readonly kind: NightOrderSpanKind;
  readonly runId: string;
  readonly pseudonymousPlanId?: string;
  readonly atUtc: string;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

/** Injectable boundary for Neatlogs; events must never contain message text or credentials. */
export interface TelegramTraceSink {
  record(event: TelegramTraceEvent): Promise<void> | void;
  runSpan?<T>(
    event: TelegramTraceEvent,
    operation: (scope: TraceSpanScope) => Promise<T>,
  ): Promise<T>;
}

export interface Clock {
  nowUtc(): string;
}

export interface PlanIdGenerator {
  nextPlanId(): string;
}

export interface AttemptFixture {
  readonly plan: TradePlan;
  readonly attempt: OrderAttempt | null;
}

export function assertUtcClockValue(value: string): string {
  return utcTimestampSchema.parse(value);
}
