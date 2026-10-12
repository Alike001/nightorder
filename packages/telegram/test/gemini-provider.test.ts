import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { OpenAIInstructionInterpreter } from '../src/openai-interpreter.js';

const validProposal = {
  asset: 'BTCUSDT',
  side: 'BUY',
  quoteBudgetUsdt: '10',
  baseQuantityBtc: null,
  triggerPrice: '60000',
  triggerOperator: 'ASK_LTE',
  limitPrice: '60000',
  expiresAtUtc: '2026-10-12T14:00:00.000Z',
  timezone: 'Africa/Lagos',
} as const;

function fakeClient(parsed: unknown, finishReason = 'stop') {
  const calls: unknown[] = [];
  const client = {
    chat: {
      completions: {
        async parse(request: unknown) {
          calls.push(request);
          return {
            choices: [
              {
                finish_reason: finishReason,
                message: { parsed, refusal: null },
              },
            ],
          };
        },
      },
    },
  } as unknown as OpenAI;
  return { client, calls };
}

describe('Gemini OpenAI-compatible instruction adapter', () => {
  it('uses chat completions and validates a structured proposal', async () => {
    const { client, calls } = fakeClient(validProposal);
    const interpreter = new OpenAIInstructionInterpreter({
      client,
      apiKey: 'fixture-not-a-secret',
      provider: 'GEMINI',
      model: 'gemini-2.5-flash-lite',
    });
    const proposal = await interpreter.interpret({
      nowUtc: '2026-10-11T20:00:00.000Z',
      messages: ['buy 10 USDT worth BTC at ask 60000'],
    });
    expect(proposal).toEqual(validProposal);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: 'gemini-2.5-flash-lite',
      response_format: { type: 'json_schema' },
    });
  });

  it('rejects missing fields rather than creating a plan', async () => {
    const { client } = fakeClient({ asset: 'BTCUSDT', side: 'BUY' });
    const interpreter = new OpenAIInstructionInterpreter({
      client,
      apiKey: 'fixture-not-a-secret',
      provider: 'GEMINI',
      model: 'gemini-2.5-flash-lite',
    });
    await expect(
      interpreter.interpret({
        nowUtc: '2026-10-11T20:00:00.000Z',
        messages: ['hi'],
      }),
    ).rejects.toThrow();
  });

  it('rejects an incomplete generation', async () => {
    const { client } = fakeClient(validProposal, 'length');
    const interpreter = new OpenAIInstructionInterpreter({
      client,
      apiKey: 'fixture-not-a-secret',
      provider: 'GEMINI',
      model: 'gemini-2.5-flash-lite',
    });
    await expect(
      interpreter.interpret({
        nowUtc: '2026-10-11T20:00:00.000Z',
        messages: ['hi'],
      }),
    ).rejects.toThrow('did not return a complete validated instruction');
  });
});
