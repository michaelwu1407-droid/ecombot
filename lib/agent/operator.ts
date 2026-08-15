import { supabaseAdmin } from '../supabase/admin';
import { logEvent } from '../log';
import { complete, LLMError, type ChatMessage } from './llm';
import { buildOperatorSystemPrompt } from './operator-prompt';
import { executeOperatorTool, operatorToolDefinitions } from './operator-tools';
import { isResearchConfigured } from '../research';
import { emptyLedger, type ToolContext } from './types';

/**
 * The operator agent (BUILD_SPEC §4.5).
 *
 * Same loop as the shopper agent, different toolset and boundaries (§2.1). The
 * differences that matter: the merchant is trusted but bounded, the task is
 * open-ended, 30 seconds is fine, and a mistake can be undone.
 *
 * No separate memory or state store (§2.6). `operator_tasks` is the record — it
 * holds the request, what was understood, and what is waiting to happen. That is
 * both the audit trail and the chat history.
 */

const MAX_ITERATIONS = 8;
/** Open-ended work with a research call in it. The shopper budget does not apply. */
const TURN_TIMEOUT_MS = 30_000;
const HISTORY_LIMIT = 12;

export interface OperatorTurn {
  answer: string;
  taskIds: string[];
  iterations: number;
  latencyMs: number;
}

export async function runOperatorTurn(params: {
  merchantId: string;
  businessName: string;
  request: string;
}): Promise<OperatorTurn> {
  const startedAt = Date.now();
  const db = supabaseAdmin();

  const history = await loadHistory(params.merchantId);

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: buildOperatorSystemPrompt({
        businessName: params.businessName,
        researchAvailable: isResearchConfigured(),
      }),
    },
    ...history,
    { role: 'user', content: params.request },
  ];

  const toolContext: ToolContext = {
    merchantId: params.merchantId,
    // The operator agent is not in a customer conversation; these exist only to
    // satisfy the shared tool signature and are never read by operator tools.
    conversationId: '',
    customerId: '',
    config: {
      brand_voice: null,
      voice_examples: [],
      discount_floor_pct: 0,
      escalation_rules: null,
      auto_send: false,
      active_hours: null,
      shipping_policy: null,
      returns_policy: null,
    },
    ledger: emptyLedger(),
    request: params.request,
  };

  const taskIds: string[] = [];
  let iterations = 0;
  let answer: string | null = null;

  while (iterations < MAX_ITERATIONS) {
    iterations += 1;

    let completion;
    try {
      completion = await complete({
        messages,
        tools: operatorToolDefinitions(),
        timeoutMs: TURN_TIMEOUT_MS,
        maxTokens: 800,
      });
    } catch (error) {
      const message = error instanceof LLMError ? error.message : String(error);
      await logEvent(params.merchantId, 'operator.model_failed', { message, iteration: iterations });
      answer = "Sorry — I couldn't get that done just now. Try again in a moment.";
      break;
    }

    await logEvent(params.merchantId, 'operator.iteration', {
      iteration: iterations,
      toolCalls: completion.toolCalls.map((call) => call.name),
      latencyMs: completion.latencyMs,
    });

    if (completion.toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: completion.text ?? '',
        tool_calls: completion.toolCalls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      });

      for (const call of completion.toolCalls) {
        const result = await executeOperatorTool(call.name, call.arguments, toolContext);

        // Any proposal that came back gets surfaced on the screen, so the merchant
        // confirms it there rather than trusting a sentence in the chat.
        const taskId = (result as { taskId?: string })?.taskId;
        if (taskId) taskIds.push(taskId);

        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }

      continue;
    }

    if (completion.text) {
      answer = completion.text;
      break;
    }

    break;
  }

  if (!answer) {
    answer =
      iterations >= MAX_ITERATIONS
        ? "That turned into more than I could work through. Could you narrow it down?"
        : "I'm not sure how to answer that one.";
  }

  // Recorded whether or not anything was proposed: this row is the chat history.
  await db.from('operator_tasks').insert({
    merchant_id: params.merchantId,
    request: params.request,
    interpretation: answer,
    action_type: 'query',
    payload: taskIds.length ? { proposedTaskIds: taskIds } : {},
    status: 'executed',
    executed_at: new Date().toISOString(),
  });

  const latencyMs = Date.now() - startedAt;
  await logEvent(params.merchantId, 'operator.turn_completed', {
    iterations,
    latencyMs,
    proposals: taskIds.length,
  });

  return { answer, taskIds, iterations, latencyMs };
}

/**
 * Recent exchanges, oldest first. Only `query` rows — a pending proposal is shown
 * as a card on the screen, not replayed as if it had already happened.
 */
async function loadHistory(merchantId: string): Promise<ChatMessage[]> {
  const { data } = await supabaseAdmin()
    .from('operator_tasks')
    .select('request, interpretation, created_at')
    .eq('merchant_id', merchantId)
    .eq('action_type', 'query')
    .eq('status', 'executed')
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);

  return (data ?? [])
    .reverse()
    .flatMap((row) => [
      { role: 'user' as const, content: row.request },
      { role: 'assistant' as const, content: row.interpretation ?? '' },
    ])
    .filter((message) => message.content.length > 0);
}
