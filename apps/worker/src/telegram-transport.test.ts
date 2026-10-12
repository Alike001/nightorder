import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SqliteTelegramDeliveryStore,
  TelegramBotApi,
  TelegramDeliveryWorker,
  type TelegramUpdate,
} from './telegram-transport.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const update = (id: number, text = '/start'): TelegramUpdate => ({
  update_id: id,
  message: {
    text,
    chat: { id: 123, type: 'private' },
    from: { id: 123 },
  },
});

function harness(options: {
  updates: TelegramUpdate[];
  failSendOnce?: boolean;
}) {
  const directory = mkdtempSync(join(tmpdir(), 'nightorder-telegram-'));
  directories.push(directory);
  const databasePath = join(directory, 'inbox.sqlite');
  const offsets: number[] = [];
  const sent: string[] = [];
  let failSend = Boolean(options.failSendOnce);
  const fetcher: typeof fetch = async (input, init) => {
    // Never expose this private URL in logs or test errors.
    const method = String(input).split('/').at(-1);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (method === 'getUpdates') {
      offsets.push(body.offset as number);
      return Response.json({
        ok: true,
        result: options.updates.filter(
          (item) => item.update_id >= Number(body.offset),
        ),
      });
    }
    if (method === 'sendMessage') {
      if (failSend) {
        failSend = false;
        return Response.json(
          { ok: false, description: 'response rejected' },
          { status: 500 },
        );
      }
      sent.push(String(body.text));
      return Response.json({ ok: true, result: { message_id: sent.length } });
    }
    throw new Error('Unexpected Telegram API method');
  };
  const store = new SqliteTelegramDeliveryStore(databasePath);
  const api = new TelegramBotApi('123:fixture-token', fetcher);
  return { store, databasePath, api, offsets, sent };
}

describe('Telegram delivery transport', () => {
  it('handles one private text update and advances the durable cursor', async () => {
    const h = harness({ updates: [update(10, '/start')] });
    let calls = 0;
    const worker = new TelegramDeliveryWorker(
      h.api,
      h.store,
      async (message) => {
        calls += 1;
        expect(message).toEqual({
          updateId: '10',
          userId: '123',
          chatId: '123',
          text: '/start',
        });
        return {
          chatId: message.chatId,
          text: 'PAPER mode only',
          kind: 'INFO',
        };
      },
    );
    expect(await worker.pollOnce()).toBe(1);
    expect(await worker.pollOnce()).toBe(0);
    expect(calls).toBe(1);
    expect(h.store.nextOffset()).toBe(11);
    expect(h.sent).toEqual(['PAPER mode only']);
    expect(h.offsets).toEqual([0, 11]);
    h.store.close();
  });

  it('never re-executes a handled update when delivery fails or times out', async () => {
    const h = harness({
      updates: [update(11, '/confirm plan 1 hash')],
      failSendOnce: true,
    });
    let calls = 0;
    const worker = new TelegramDeliveryWorker(
      h.api,
      h.store,
      async (message) => {
        calls += 1;
        return { chatId: message.chatId, text: 'Plan approved and ARMED' };
      },
    );
    await expect(worker.pollOnce()).rejects.toThrow('TELEGRAM_HTTP_500');
    expect(h.store.nextOffset()).toBe(0);
    expect(await worker.pollOnce()).toBe(1);
    expect(calls).toBe(1);
    expect(h.sent).toEqual(['Plan approved and ARMED']);
    expect(h.store.nextOffset()).toBe(12);
    h.store.close();
  });

  it('reports interrupted handler as uncertain instead of replaying it after process restart', async () => {
    const h = harness({ updates: [update(14, '/confirm plan 1 hash')] });
    const worker = new TelegramDeliveryWorker(h.api, h.store, async () => {
      throw new Error('handler crashed after a potentially committed approval');
    });
    await expect(worker.pollOnce()).rejects.toThrow('handler crashed');
    h.store.close();

    const reopened = new SqliteTelegramDeliveryStore(h.databasePath);
    let replayed = 0;
    const recovered = new TelegramDeliveryWorker(h.api, reopened, async () => {
      replayed += 1;
      throw new Error('must not replay');
    });
    expect(await recovered.pollOnce()).toBe(1);
    expect(replayed).toBe(0);
    expect(h.sent[0]).toContain('outcome may be uncertain');
    expect(reopened.nextOffset()).toBe(15);
    reopened.close();
  });

  it('ignores group updates and media without calling the instruction handler', async () => {
    const group = update(20, '/new buy');
    if (group.message?.chat) group.message.chat.type = 'group';
    const media = update(21);
    if (media.message) delete media.message.text;
    const h = harness({ updates: [group, media] });
    let calls = 0;
    const worker = new TelegramDeliveryWorker(h.api, h.store, async () => {
      calls += 1;
      return { chatId: '123', text: 'should not be sent' };
    });
    expect(await worker.pollOnce()).toBe(0);
    expect(calls).toBe(0);
    expect(h.store.nextOffset()).toBe(22);
    expect(h.sent).toEqual([]);
    h.store.close();
  });

  it('refuses a handler response to an unrelated chat', async () => {
    const h = harness({ updates: [update(30)] });
    const worker = new TelegramDeliveryWorker(h.api, h.store, async () => ({
      chatId: '999',
      text: 'private reply',
    }));
    await expect(worker.pollOnce()).rejects.toThrow('originating private chat');
    expect(h.sent).toEqual([]);
    h.store.close();
  });

  it('keeps bot tokens out of API failure exceptions', async () => {
    const token = '123:secret-bot-token';
    const api = new TelegramBotApi(token, async () => {
      throw new Error(`test transport leak ${token}`);
    });
    try {
      await api.getUpdates(0);
      throw new Error('must fail');
    } catch (error) {
      expect(String(error)).toBe('Error: TELEGRAM_NETWORK_UNAVAILABLE');
      expect(String(error)).not.toContain(token);
    }
  });
});
