/**
 * Telegram Bot API long-polling bridge for NightOrder.
 *
 * Safety: never logs bot tokens, ignores group/non-text updates, and reserves
 * each update BEFORE invoking the workflow. A crash after a side effect is
 * reported as uncertain rather than silently replaying the same command.
 * Only PAPER-mode handlers should be wired to this transport.
 */
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface TelegramIncomingMessage {
  updateId: string;
  chatId: string;
  userId: string;
  text: string;
}

export interface TelegramOutgoingReply {
  chatId: string;
  text: string;
  kind?: string;
}

export type TelegramMessageHandler = (
  message: TelegramIncomingMessage,
) => Promise<TelegramOutgoingReply>;

export interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat?: { id?: number; type?: string };
    from?: { id?: number };
  };
}

export interface TelegramDeliveryStore {
  nextOffset(): number;
  reserve(updateId: number): boolean;
  savedReply(updateId: number): TelegramOutgoingReply | null;
  complete(updateId: number, reply: TelegramOutgoingReply): void;
  advanceOffset(nextOffset: number): void;
}

const INTERRUPTED_MESSAGE =
  'A previous NightOrder request was interrupted. Its outcome may be uncertain. ' +
  'Use /plans and /status to check the persisted plan before submitting anything again.';

export class SqliteTelegramDeliveryStore implements TelegramDeliveryStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath.trim().length === 0) {
      throw new Error('A durable delivery database path is required');
    }
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    try {
      chmodSync(databasePath, 0o600);
    } catch {
      // Some filesystems do not support chmod; protect the directory separately.
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS telegram_delivery_cursor (
        id INTEGER PRIMARY KEY CHECK(id = 1), next_offset INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO telegram_delivery_cursor(id, next_offset) VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS telegram_delivery_outbox (
        update_id INTEGER PRIMARY KEY,
        state TEXT NOT NULL CHECK(state IN ('RESERVED', 'COMPLETED')),
        reply_chat_id TEXT,
        reply_text TEXT,
        reply_kind TEXT
      );
    `);
  }

  nextOffset(): number {
    const row = this.db
      .prepare('SELECT next_offset FROM telegram_delivery_cursor WHERE id = 1')
      .get() as { next_offset: number } | undefined;
    return row?.next_offset ?? 0;
  }

  /** False means the update was already reserved/processed; never execute it again. */
  reserve(updateId: number): boolean {
    validateUpdateId(updateId);
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO telegram_delivery_outbox(update_id, state) VALUES (?, 'RESERVED')",
      )
      .run(updateId);
    return result.changes === 1;
  }

  savedReply(updateId: number): TelegramOutgoingReply | null {
    const row = this.db
      .prepare(
        'SELECT state, reply_chat_id, reply_text, reply_kind FROM telegram_delivery_outbox WHERE update_id = ?',
      )
      .get(updateId) as
      | {
          state: string;
          reply_chat_id: string | null;
          reply_text: string | null;
          reply_kind: string | null;
        }
      | undefined;
    if (
      !row ||
      row.state !== 'COMPLETED' ||
      row.reply_chat_id === null ||
      row.reply_text === null
    ) {
      return null;
    }
    return {
      chatId: row.reply_chat_id,
      text: row.reply_text,
      ...(row.reply_kind === null ? {} : { kind: row.reply_kind }),
    };
  }

  complete(updateId: number, reply: TelegramOutgoingReply): void {
    if (reply.text.trim().length === 0)
      throw new Error('Refusing empty Telegram reply');
    const result = this.db
      .prepare(
        "UPDATE telegram_delivery_outbox SET state = 'COMPLETED', reply_chat_id = ?, reply_text = ?, reply_kind = ? WHERE update_id = ? AND state = 'RESERVED'",
      )
      .run(reply.chatId, reply.text, reply.kind ?? null, updateId);
    if (result.changes !== 1)
      throw new Error('Telegram update is not reserved for completion');
  }

  advanceOffset(nextOffset: number): void {
    validateUpdateId(nextOffset);
    this.db
      .prepare(
        'UPDATE telegram_delivery_cursor SET next_offset = MAX(next_offset, ?) WHERE id = 1',
      )
      .run(nextOffset);
  }

  close(): void {
    this.db.close();
  }
}

function validateUpdateId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid Telegram update identifier');
  }
}

export class TelegramBotApi {
  private readonly baseUrl: string;

  constructor(
    token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
      throw new Error('Invalid Telegram bot token format');
    }
    // Keep the URL private. Never include it in error messages or traces.
    this.baseUrl = `https://api.telegram.org/bot${token}/`;
  }

  private async request(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch {
      throw new Error('TELEGRAM_NETWORK_UNAVAILABLE');
    }
    if (!response.ok) throw new Error(`TELEGRAM_HTTP_${response.status}`);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('TELEGRAM_MALFORMED_RESPONSE');
    }
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('ok' in payload) ||
      payload.ok !== true ||
      !('result' in payload)
    ) {
      throw new Error('TELEGRAM_REQUEST_REJECTED');
    }
    return payload.result;
  }

  async getUpdates(
    offset: number,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    validateUpdateId(offset);
    const result = await this.request(
      'getUpdates',
      {
        offset,
        timeout: 20,
        limit: 20,
        allowed_updates: ['message'],
      },
      signal,
    );
    if (!Array.isArray(result)) throw new Error('TELEGRAM_INVALID_UPDATES');
    if (!result.every((item) => isUpdate(item)))
      throw new Error('TELEGRAM_INVALID_UPDATES');
    return (result as TelegramUpdate[]).sort(
      (a, b) => a.update_id - b.update_id,
    );
  }

  async sendMessage(
    chatId: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (text.length > 4096 || text.trim().length === 0) {
      throw new Error('TELEGRAM_INVALID_REPLY');
    }
    await this.request('sendMessage', { chat_id: chatId, text }, signal);
  }
}

function isUpdate(value: unknown): value is TelegramUpdate {
  if (!value || typeof value !== 'object' || !('update_id' in value))
    return false;
  const id = value.update_id;
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= 0;
}

function toIncoming(update: TelegramUpdate): TelegramIncomingMessage | null {
  const message = update.message;
  if (!message || message.chat?.type !== 'private') return null;
  if (
    !Number.isSafeInteger(message.chat.id) ||
    !Number.isSafeInteger(message.from?.id)
  )
    return null;
  if (
    typeof message.text !== 'string' ||
    message.text.trim().length === 0 ||
    message.text.length > 4096
  )
    return null;
  return {
    updateId: String(update.update_id),
    chatId: String(message.chat.id),
    userId: String(message.from?.id),
    text: message.text,
  };
}

/**
 * A single worker must own this cursor/database. Never run two pollers against
 * the same Telegram bot token. The handler must enforce its own owner allowlist.
 */
export class TelegramDeliveryWorker {
  constructor(
    private readonly api: TelegramBotApi,
    private readonly store: TelegramDeliveryStore,
    private readonly handler: TelegramMessageHandler,
  ) {}

  async pollOnce(signal?: AbortSignal): Promise<number> {
    const updates = await this.api.getUpdates(this.store.nextOffset(), signal);
    let processed = 0;
    for (const update of updates) {
      if (signal?.aborted) break;
      if (update.update_id < this.store.nextOffset()) continue;
      const incoming = toIncoming(update);
      if (!incoming) {
        this.store.advanceOffset(update.update_id + 1);
        continue;
      }

      const wasNew = this.store.reserve(update.update_id);
      let reply = this.store.savedReply(update.update_id);
      if (!reply) {
        if (wasNew) {
          const produced = await this.handler(incoming);
          if (produced.chatId !== incoming.chatId) {
            throw new Error(
              'Telegram reply chat must match originating private chat',
            );
          }
          this.store.complete(update.update_id, produced);
          reply = produced;
        } else {
          // An uncertain side effect must never cause automatic re-execution.
          reply = {
            chatId: incoming.chatId,
            text: INTERRUPTED_MESSAGE,
            kind: 'ERROR',
          };
          this.store.complete(update.update_id, reply);
        }
      }
      if (reply.chatId !== incoming.chatId)
        throw new Error('Stored Telegram reply chat mismatch');
      await this.api.sendMessage(reply.chatId, reply.text, signal);
      this.store.advanceOffset(update.update_id + 1);
      processed += 1;
    }
    return processed;
  }

  async runUntilAborted(
    signal: AbortSignal,
    onError: (code: string) => void = () => {},
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.pollOnce(signal);
      } catch {
        if (signal.aborted) break;
        // Intentionally do not log error objects, which can include URLs/tokens.
        onError('TELEGRAM_POLL_FAILED');
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 2000);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timeout);
              resolve();
            },
            { once: true },
          );
        });
      }
    }
  }
}
