import { describe, expect, it } from 'vitest';
import { GeminiDiagnosticModel } from './gemini-diagnostic.js';
import { validatePaperWorkerEnvironment } from './live-paper.js';

const env = {
  TELEGRAM_ALLOWED_USER_IDS: '1234567',
  GEMINI_API_KEY: 'test-key',
  GEMINI_MODEL: 'gemini-2.5-flash-lite',
  NIGHTORDER_ENABLE_PAPER_EXECUTION: 'true',
};

describe('integrated PAPER worker safety gates', () => {
  it('rejects missing explicit arming', () => {
    expect(() =>
      validatePaperWorkerEnvironment({
        ...env,
        NIGHTORDER_ENABLE_PAPER_EXECUTION: 'false',
      }),
    ).toThrow('explicitly armed');
  });
  it('rejects multi-owner and nonnumeric owner IDs', () => {
    expect(() =>
      validatePaperWorkerEnvironment({
        ...env,
        TELEGRAM_ALLOWED_USER_IDS: '123,456',
      }),
    ).toThrow('exactly one numeric');
    expect(() =>
      validatePaperWorkerEnvironment({
        ...env,
        TELEGRAM_ALLOWED_USER_IDS: 'not-an-id',
      }),
    ).toThrow('exactly one numeric');
  });
  it('uses shared plan database and PAPER-only virtual balances', () => {
    const config = validatePaperWorkerEnvironment(env);
    expect(config.databasePath.endsWith('data/nightorder.sqlite')).toBe(true);
    expect(config.initialUsdt).toBe('1000');
    expect(config.initialBtc).toBe('0.25');
  });
  it('normalizes genuine Gemini tool calls for bounded read-only recovery', async () => {
    const fakeFetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: { name: 'read_attempt_journal', arguments: '{}' },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    const model = new GeminiDiagnosticModel(
      'test-key',
      'gemini-2.5-flash-lite',
      fakeFetch as typeof fetch,
    );
    const response = await model.next(
      [{ role: 'user', content: 'Investigate only.' }],
      true,
    );
    expect(response).toEqual([
      {
        type: 'function_call',
        call_id: 'call-1',
        name: 'read_attempt_journal',
        arguments: '{}',
      },
    ]);
  });
});
