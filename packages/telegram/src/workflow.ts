import { randomUUID } from 'node:crypto';
import {
  compareUtcTimestamps,
  hashTradeInstruction,
  ianaTimezoneSchema,
  immutableTradeInstructionSchema,
  positiveDecimalSchema,
  sha256DigestSchema,
  stableIdSchema,
  tradePlanSchema,
  utcTimestampSchema,
  type ImmutableTradeInstruction,
  type TradePlan,
} from '@nightorder/domain';
import {
  assertUtcClockValue,
  instructionProposalSchema,
  telegramMessageSchema,
  telegramReplySchema,
  type ClarificationField,
  type Clock,
  type InstructionInterpreter,
  type InstructionProposal,
  type PlanIdGenerator,
  type TelegramMessage,
  type TelegramPlanRepository,
  type TelegramReply,
  type TelegramReplyKind,
  type TelegramTraceSink,
} from './contracts.js';
import {
  formatPlanPreview,
  formatPlanStatus,
  formatPlanSummary,
} from './presentation.js';

class SystemClock implements Clock {
  nowUtc(): string {
    return new Date().toISOString();
  }
}

class UuidPlanIdGenerator implements PlanIdGenerator {
  nextPlanId(): string {
    return randomUUID();
  }
}

class NoopTraceSink implements TelegramTraceSink {
  record(): void {}
}

interface ParsedCommand {
  readonly name: string;
  readonly args: readonly string[];
  readonly rawArguments: string;
}

export interface TelegramWorkflowOptions {
  readonly allowedUserIds: readonly string[];
  readonly repository: TelegramPlanRepository;
  readonly interpreter: InstructionInterpreter;
  readonly clock?: Clock;
  readonly planIdGenerator?: PlanIdGenerator;
  readonly trace?: TelegramTraceSink;
}

interface CompleteProposal {
  readonly instruction: ImmutableTradeInstruction;
}

interface AmbiguousProposal {
  readonly fields: readonly ClarificationField[];
}

export class TelegramInstructionWorkflow {
  private readonly allowlist: ReadonlySet<string>;
  private readonly repository: TelegramPlanRepository;
  private readonly interpreter: InstructionInterpreter;
  private readonly clock: Clock;
  private readonly planIdGenerator: PlanIdGenerator;
  private readonly trace: TelegramTraceSink;
  private readonly conversations = new Map<string, string[]>();

  constructor(options: TelegramWorkflowOptions) {
    if (options.allowedUserIds.length === 0) {
      throw new Error('Telegram allowlist must contain at least one user ID');
    }
    this.allowlist = new Set(
      options.allowedUserIds.map((userId) => stableIdSchema.parse(userId)),
    );
    this.repository = options.repository;
    this.interpreter = options.interpreter;
    this.clock = options.clock ?? new SystemClock();
    this.planIdGenerator = options.planIdGenerator ?? new UuidPlanIdGenerator();
    this.trace = options.trace ?? new NoopTraceSink();
  }

  async handle(messageInput: TelegramMessage): Promise<TelegramReply> {
    const message = telegramMessageSchema.parse(messageInput);
    const nowUtc = assertUtcClockValue(this.clock.nowUtc());
    if (!this.allowlist.has(message.userId)) {
      await this.traceSafely('telegram.authorization.denied', nowUtc, {
        command: commandName(message.text),
      });
      return this.reply(
        message.chatId,
        'ERROR',
        'Unauthorized. This paper-trading bot is restricted to its server-side allowlist.',
      );
    }

    const command = parseCommand(message.text);
    await this.traceSafely('telegram.command.received', nowUtc, {
      command: command?.name ?? 'clarification',
      authorized: true,
    });

    if (!command) {
      return this.handleClarification(message, nowUtc);
    }

    switch (command.name) {
      case 'start':
        return this.handleStart(message.chatId);
      case 'new':
        return this.handleNew(message, command.rawArguments, nowUtc);
      case 'plans':
        return this.handlePlans(message);
      case 'status':
        return this.handleStatus(message, command.args, nowUtc);
      case 'confirm':
        return this.handleConfirm(message, command.args, nowUtc);
      case 'cancel':
        return this.handleCancel(message, command.args, nowUtc);
      default:
        return this.reply(
          message.chatId,
          'ERROR',
          'Unknown command. Use /start, /new, /plans, /status, or /cancel.',
        );
    }
  }

  private handleStart(chatId: string): TelegramReply {
    return this.reply(
      chatId,
      'INFO',
      [
        'NightOrder is PAPER ONLY and never places real-money trades.',
        '/new <instruction> — propose an exact BTC/USDT plan',
        '/plans — list your persisted plans',
        '/status <planId> — show truthful plan/order state',
        '/cancel <planId> — cancel or request cancellation',
        'A preview supplies the exact /confirm command required to arm a plan.',
      ].join('\n'),
    );
  }

  private async handleNew(
    message: TelegramMessage,
    instruction: string,
    nowUtc: string,
  ): Promise<TelegramReply> {
    this.conversations.set(message.userId, []);
    if (instruction.length === 0) {
      return this.reply(
        message.chatId,
        'INFO',
        'Describe one BTC/USDT PAPER instruction, including BUY/SELL, amount, price condition, worst limit, expiry, and timezone.',
      );
    }
    return this.interpretAndPreview(message, instruction, nowUtc);
  }

  private async handleClarification(
    message: TelegramMessage,
    nowUtc: string,
  ): Promise<TelegramReply> {
    if (!this.conversations.has(message.userId)) {
      return this.reply(
        message.chatId,
        'ERROR',
        'Start an instruction with /new before sending plan details.',
      );
    }
    return this.interpretAndPreview(message, message.text, nowUtc);
  }

  private async interpretAndPreview(
    message: TelegramMessage,
    input: string,
    nowUtc: string,
  ): Promise<TelegramReply> {
    const conversation = this.conversations.get(message.userId) ?? [];
    conversation.push(input);
    this.conversations.set(message.userId, conversation.slice(-8));

    let proposal: InstructionProposal;
    try {
      proposal = instructionProposalSchema.parse(
        await this.interpreter.interpret({
          nowUtc,
          messages: this.conversations.get(message.userId) ?? [],
        }),
      );
    } catch {
      await this.traceSafely('telegram.interpretation.failed', nowUtc, {
        safeFailure: true,
      });
      return this.reply(
        message.chatId,
        'ERROR',
        'I could not validate the model output, so no plan was created. Please restate the instruction.',
      );
    }

    const assessment = assessProposal(
      proposal,
      message.userId,
      this.planIdGenerator.nextPlanId(),
      nowUtc,
    );
    if ('fields' in assessment) {
      await this.traceSafely('telegram.clarification.required', nowUtc, {
        fields: assessment.fields.join(','),
      });
      return this.reply(
        message.chatId,
        'CLARIFICATION',
        formatClarification(assessment.fields),
      );
    }

    const draft = tradePlanSchema.parse({
      ...assessment.instruction,
      planHash: hashTradeInstruction(assessment.instruction),
      state: 'DRAFT',
      revision: 0,
    });

    try {
      await this.repository.createDraft(draft);
    } catch {
      return this.reply(
        message.chatId,
        'ERROR',
        'The proposal could not be persisted, so it was not presented for approval.',
      );
    }
    const awaiting: TradePlan = {
      ...draft,
      state: 'AWAITING_CONFIRMATION',
      revision: 1,
    };
    const stored = await this.repository.saveTransition(
      awaiting,
      draft.revision,
      nowUtc,
    );
    if (!stored.ok) {
      return this.reply(
        message.chatId,
        'ERROR',
        `The proposal was not made approvable: ${stored.message}`,
      );
    }

    this.conversations.delete(message.userId);
    await this.repository.recordObservation(stored.data.id, {
      type: 'TELEGRAM_PREVIEWED',
      atUtc: nowUtc,
      revision: stored.data.revision,
    });
    await this.traceSafely('telegram.plan.previewed', nowUtc, {
      planId: stored.data.id,
      revision: stored.data.revision,
      mode: stored.data.mode,
    });
    return this.reply(
      message.chatId,
      'PREVIEW',
      formatPlanPreview(stored.data),
    );
  }

  private async handlePlans(message: TelegramMessage): Promise<TelegramReply> {
    const plans = await this.repository.listPlansByOwner(message.userId);
    return this.reply(
      message.chatId,
      'STATUS',
      plans.length === 0
        ? 'You have no persisted plans.'
        : ['Your plans:', ...plans.map(formatPlanSummary)].join('\n'),
    );
  }

  private async handleStatus(
    message: TelegramMessage,
    args: readonly string[],
    nowUtc: string,
  ): Promise<TelegramReply> {
    if (args.length !== 1) {
      return this.reply(message.chatId, 'ERROR', 'Usage: /status <planId>');
    }
    const plan = await this.repository.loadPlan(args[0] ?? '');
    if (!plan) {
      return this.reply(message.chatId, 'ERROR', 'Plan not found.');
    }
    if (plan.ownerId !== message.userId) {
      return this.reply(
        message.chatId,
        'ERROR',
        'Unauthorized. You cannot view another owner’s plan.',
      );
    }
    const attempt = await this.repository.loadAttempt(plan.id);
    return this.reply(
      message.chatId,
      'STATUS',
      formatPlanStatus(plan, attempt, nowUtc),
    );
  }

  private async handleConfirm(
    message: TelegramMessage,
    args: readonly string[],
    nowUtc: string,
  ): Promise<TelegramReply> {
    if (args.length !== 3) {
      return this.reply(
        message.chatId,
        'ERROR',
        'Use the exact /confirm <planId> <revision> <digest> command from the latest preview.',
      );
    }
    const [planId = '', revisionText = '', digest = ''] = args;
    const revision = parseRevision(revisionText);
    if (revision === null || !sha256DigestSchema.safeParse(digest).success) {
      return this.reply(
        message.chatId,
        'ERROR',
        'Confirmation revision or SHA-256 digest is invalid.',
      );
    }

    const result = await this.repository.approveExactAtRevision(
      planId,
      message.userId,
      digest,
      revision,
      nowUtc,
    );
    if (!result.ok) {
      await this.traceSafely('telegram.approval.rejected', nowUtc, {
        planId,
        code: result.code,
      });
      return this.reply(
        message.chatId,
        'ERROR',
        `Plan was not approved: ${result.message}`,
      );
    }

    await this.repository.recordObservation(result.data.id, {
      type: 'TELEGRAM_APPROVED',
      atUtc: nowUtc,
      revision: result.data.revision,
      digest: result.data.planHash,
    });
    await this.traceSafely('telegram.approval.accepted', nowUtc, {
      planId: result.data.id,
      revision: result.data.revision,
      state: result.data.state,
    });
    return this.reply(
      message.chatId,
      'APPROVED',
      `Plan ${result.data.id} is ARMED in PAPER mode. No order has been accepted or filled.`,
    );
  }

  private async handleCancel(
    message: TelegramMessage,
    args: readonly string[],
    nowUtc: string,
  ): Promise<TelegramReply> {
    if (args.length !== 1) {
      return this.reply(message.chatId, 'ERROR', 'Usage: /cancel <planId>');
    }
    const planId = args[0] ?? '';
    const plan = await this.repository.loadPlan(planId);
    if (!plan) return this.reply(message.chatId, 'ERROR', 'Plan not found.');
    const result = await this.repository.cancelOwnedAtRevision(
      plan.id,
      message.userId,
      plan.revision,
      nowUtc,
    );
    if (!result.ok) {
      await this.traceSafely('telegram.cancellation.rejected', nowUtc, {
        planId,
        code: result.code,
      });
      return this.reply(
        message.chatId,
        'ERROR',
        `Cancellation did not change the plan: ${result.message}`,
      );
    }

    await this.repository.recordObservation(result.data.id, {
      type: 'TELEGRAM_CANCELLATION',
      atUtc: nowUtc,
      resultingState: result.data.state,
      revision: result.data.revision,
    });
    await this.traceSafely('telegram.cancellation.recorded', nowUtc, {
      planId: result.data.id,
      state: result.data.state,
    });
    const text =
      result.data.state === 'CANCEL_REQUESTED'
        ? `Plan ${planId}: cancellation requested. It is not cancelled until readback confirms cancellation.`
        : result.data.state === 'CANCELLED'
          ? `Plan ${planId}: cancelled before submission; no order was sent.`
          : result.data.state === 'EXPIRED'
            ? `Plan ${planId}: already expired; no new order is authorized.`
            : `Plan ${planId}: ${result.data.state}.`;
    return this.reply(message.chatId, 'CANCELLATION', text);
  }

  private reply(
    chatId: string,
    kind: TelegramReplyKind,
    text: string,
  ): TelegramReply {
    return telegramReplySchema.parse({ chatId, kind, text });
  }

  private async traceSafely(
    name: string,
    atUtc: string,
    attributes: Readonly<Record<string, string | number | boolean>>,
  ): Promise<void> {
    try {
      await this.trace.record({ name, atUtc, attributes });
    } catch {
      // Observability must not change authorization or persistence behavior.
    }
  }
}

export function telegramAllowlistFromEnv(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => stableIdSchema.parse(entry));
}

function assessProposal(
  proposal: InstructionProposal,
  ownerId: string,
  planId: string,
  nowUtc: string,
): CompleteProposal | AmbiguousProposal {
  const fields = new Set<ClarificationField>();
  const normalizedAsset = proposal.asset?.replace(/[\s/_-]/g, '').toUpperCase();
  if (normalizedAsset !== 'BTCUSDT') fields.add('ASSET');
  if (proposal.side === null) fields.add('DIRECTION');

  if (
    proposal.side === null ||
    (proposal.side === 'BUY' &&
      (!isPositiveDecimal(proposal.quoteBudgetUsdt) ||
        proposal.baseQuantityBtc !== null)) ||
    (proposal.side === 'SELL' &&
      (!isPositiveDecimal(proposal.baseQuantityBtc) ||
        proposal.quoteBudgetUsdt !== null))
  ) {
    fields.add('AMOUNT');
  }

  if (
    !isPositiveDecimal(proposal.triggerPrice) ||
    proposal.triggerOperator === null ||
    (proposal.side === 'BUY' && proposal.triggerOperator !== 'ASK_LTE') ||
    (proposal.side === 'SELL' && proposal.triggerOperator !== 'BID_GTE')
  ) {
    fields.add('PRICE_CONDITION');
  }
  if (!isPositiveDecimal(proposal.limitPrice)) fields.add('EXECUTION_LIMIT');
  if (
    proposal.expiresAtUtc === null ||
    proposal.timezone === null ||
    !utcTimestampSchema.safeParse(proposal.expiresAtUtc).success ||
    !ianaTimezoneSchema.safeParse(proposal.timezone).success ||
    (utcTimestampSchema.safeParse(proposal.expiresAtUtc).success &&
      compareUtcTimestamps(proposal.expiresAtUtc, nowUtc) <= 0)
  ) {
    fields.add('EXPIRY');
  }

  if (fields.size > 0) return { fields: [...fields] };

  const common = {
    id: stableIdSchema.parse(planId),
    ownerId,
    symbol: 'BTCUSDT' as const,
    triggerPrice: positiveDecimalSchema.parse(proposal.triggerPrice),
    triggerOperator: proposal.triggerOperator,
    limitPrice: positiveDecimalSchema.parse(proposal.limitPrice),
    expiresAtUtc: utcTimestampSchema.parse(proposal.expiresAtUtc),
    timezone: ianaTimezoneSchema.parse(proposal.timezone),
    mode: 'PAPER' as const,
  };
  const candidate =
    proposal.side === 'BUY'
      ? {
          ...common,
          side: 'BUY' as const,
          quoteBudgetUsdt: positiveDecimalSchema.parse(
            proposal.quoteBudgetUsdt,
          ),
        }
      : {
          ...common,
          side: 'SELL' as const,
          baseQuantityBtc: positiveDecimalSchema.parse(
            proposal.baseQuantityBtc,
          ),
        };

  const parsed = immutableTradeInstructionSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      fields: clarificationFieldsForIssues(
        parsed.error.issues.map((issue) => String(issue.path[0] ?? '')),
      ),
    };
  }
  return { instruction: parsed.data };
}

function clarificationFieldsForIssues(
  paths: readonly string[],
): readonly ClarificationField[] {
  const fields = new Set<ClarificationField>();
  for (const path of paths) {
    if (path === 'symbol') fields.add('ASSET');
    else if (path === 'side') fields.add('DIRECTION');
    else if (path.includes('Quantity') || path.includes('Budget'))
      fields.add('AMOUNT');
    else if (path.startsWith('trigger')) fields.add('PRICE_CONDITION');
    else if (path === 'limitPrice') fields.add('EXECUTION_LIMIT');
    else if (path === 'expiresAtUtc' || path === 'timezone')
      fields.add('EXPIRY');
  }
  return fields.size > 0 ? [...fields] : ['PRICE_CONDITION'];
}

function isPositiveDecimal(value: string | null): value is string {
  return value !== null && positiveDecimalSchema.safeParse(value).success;
}

function formatClarification(fields: readonly ClarificationField[]): string {
  const questions: Record<ClarificationField, string> = {
    ASSET: 'Asset: explicitly confirm BTC/USDT (the only supported market).',
    DIRECTION: 'Direction: is this a BUY or SELL?',
    AMOUNT:
      'Amount: for BUY give the maximum USDT budget; for SELL give the BTC quantity.',
    PRICE_CONDITION:
      'Price condition: give the exact ask-at-or-below BUY trigger or bid-at-or-above SELL trigger.',
    EXECUTION_LIMIT:
      'Execution limit: give the exact worst permitted limit price.',
    EXPIRY:
      'Expiry: give an unambiguous future time and IANA timezone (for example Africa/Lagos).',
  };
  return [
    'I will not create or arm an ambiguous plan. Please clarify:',
    ...fields.map((field) => `- ${questions[field]}`),
  ].join('\n');
}

function parseRevision(value: string): number | null {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const revision = Number(value);
  return Number.isSafeInteger(revision) ? revision : null;
}

function parseCommand(text: string): ParsedCommand | null {
  if (!text.startsWith('/')) return null;
  const [head = '', ...args] = text.split(/\s+/);
  const name = head.slice(1).split('@')[0]?.toLowerCase() ?? '';
  return {
    name,
    args,
    rawArguments: text.slice(head.length).trim(),
  };
}

function commandName(text: string): string {
  return parseCommand(text)?.name ?? 'text';
}
