import { env } from '../env';
import type { ToolCall, ToolDefinition } from './types';

/**
 * OpenRouter, one pinned model (§3.6).
 *
 * Never `auto`: auto-routing gives inconsistent tone, variable tool-calling
 * reliability and unpredictable cost, and a sales agent has to behave identically
 * every time. `env.openRouterModel()` rejects `auto` outright.
 *
 * Plain fetch, no SDK — the surface is one endpoint.
 */

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface CompletionResult {
  text: string | null;
  toolCalls: ToolCall[];
  /** Wall-clock time for this call, used to explain where latency went. */
  latencyMs: number;
}

export class LLMError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = 'LLMError';
    this.retryable = retryable;
  }
}

export async function complete(params: {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** Shopper agent gets 5 seconds end to end; the operator agent can take 30. */
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  model?: string;
}): Promise<CompletionResult> {
  const startedAt = Date.now();

  const body: Record<string, unknown> = {
    model: params.model ?? env.openRouterModel(),
    messages: params.messages,
    max_tokens: params.maxTokens ?? 512,
    temperature: params.temperature ?? 0.3,
  };

  if (params.tools?.length) {
    body.tools = params.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.openRouterApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(params.timeoutMs ?? 12_000),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new LLMError(timedOut ? 'Model call timed out' : `Model call failed: ${error}`, true);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new LLMError(
      `OpenRouter returned ${response.status}: ${detail.slice(0, 300)}`,
      response.status === 429 || response.status >= 500
    );
  }

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      };
    }>;
    error?: { message?: string };
  };

  if (payload.error) throw new LLMError(payload.error.message ?? 'OpenRouter returned an error');

  const message = payload.choices?.[0]?.message;
  if (!message) throw new LLMError('OpenRouter returned no choices');

  const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((call) => ({
    id: call.id,
    name: call.function.name,
    // Arguments arrive as a JSON string and are model-generated, so they can be
    // malformed. An unparseable call becomes an empty object; the tool's own
    // validation then rejects it with a message the model can recover from.
    arguments: safeParseArguments(call.function.arguments),
  }));

  return {
    text: message.content?.trim() || null,
    toolCalls,
    latencyMs: Date.now() - startedAt,
  };
}

function safeParseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
