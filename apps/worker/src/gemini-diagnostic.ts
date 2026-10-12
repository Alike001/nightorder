/** Google Gemini tool-call adapter for bounded, read-only recovery diagnostics. */
import type {
  DiagnosticModel,
  ModelInputItem,
  ModelOutputItem,
} from '@nightorder/agent';

const readOnlyTools = [
  {
    type: 'function',
    function: {
      name: 'read_attempt_journal',
      description:
        'Inspect the durable order-attempt journal for the incident.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_order_by_client_id',
      description: 'Read the existing PAPER order by its client ID.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_independent_verifier',
      description:
        'Verify actual persisted authorization and execution records.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
] as const;

interface CompletionMessage {
  role?: string;
  content?: string | null;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

export class GeminiDiagnosticModel implements DiagnosticModel {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (!apiKey.trim() || !model.trim()) {
      throw new Error('Gemini recovery API key and model are required');
    }
  }

  async next(
    input: readonly ModelInputItem[],
    toolsEnabled: boolean,
  ): Promise<readonly ModelOutputItem[]> {
    const messages: Array<Record<string, unknown>> = [
      {
        role: 'system',
        content:
          'Diagnose PAPER order uncertainty using only read-only tools. ' +
          'Pick ONE relevant tool per turn, never modify, repeat or submit an order. ' +
          'Trust persisted evidence, not acknowledgments. If uncertain, say so.',
      },
    ];
    for (const item of input) {
      if (item.role === 'user' && typeof item.content === 'string') {
        messages.push({ role: 'user', content: item.content });
      } else if (
        item.type === 'function_call' &&
        typeof item.call_id === 'string' &&
        typeof item.name === 'string' &&
        typeof item.arguments === 'string'
      ) {
        messages.push({
          role: 'assistant',
          tool_calls: [
            {
              id: item.call_id,
              type: 'function',
              function: { name: item.name, arguments: item.arguments },
            },
          ],
        });
      } else if (
        item.type === 'function_call_output' &&
        typeof item.call_id === 'string' &&
        typeof item.output === 'string'
      ) {
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id,
          content: item.output,
        });
      }
    }
    const response = await this.fetcher(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0,
          max_tokens: 300,
          ...(toolsEnabled
            ? { tools: readOnlyTools, tool_choice: 'auto' }
            : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Gemini diagnostic HTTP ${response.status}`);
    }
    const raw: unknown = await response.json();
    if (raw === null || typeof raw !== 'object' || !('choices' in raw)) {
      throw new Error('Gemini diagnostic response lacks choices');
    }
    const choices = (
      raw as { choices?: Array<{ message?: CompletionMessage }> }
    ).choices;
    const message = choices?.[0]?.message;
    if (!message) throw new Error('Gemini diagnostic response has no message');

    if (message.tool_calls?.length) {
      return message.tool_calls.map((call) => ({
        type: 'function_call',
        call_id: call.id,
        name: call.function?.name,
        arguments: call.function?.arguments,
      }));
    }
    return [{ type: 'message', content: message.content ?? '' }];
  }
}
