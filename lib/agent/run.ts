import { supabaseAdmin } from '../supabase/admin';
import { logEvent } from '../log';
import { complete, LLMError, type ChatMessage } from './llm';
import { buildShopperSystemPrompt } from './prompt';
import { executeTool, SHOPPER_TOOL_DEFINITIONS } from './tools';
import { deliverReply, type DeliveryOutcome } from './deliver';
import { emptyLedger, type ShopperContext, type ToolContext, type TurnLedger } from './types';

/**
 * The shopper agent loop (BUILD_SPEC §4.4).
 *
 * A plain tool-calling loop in our own code — no framework (§3.1). This is a
 * stateless request/response pipeline with a five-second budget; a framework would
 * add multi-pass latency, a server to own, a second data store the dashboard
 * cannot read, and an attack surface exposed to untrusted public input.
 *
 * Flag if this ever grows task decomposition, subagents, or long-running
 * multi-step workflows. That is where a framework earns its keep.
 */

const MAX_ITERATIONS = 6;
const HISTORY_LIMIT = 20;

/**
 * Speed is the feature (§1.4): shoppers message several boutiques at once and the
 * first accurate reply takes the money. So the turn runs against a wall-clock
 * deadline, not just a per-call timeout.
 *
 * A tool-using turn is at least two model round trips — one to choose tools, one
 * to write the reply — so a per-call timeout alone cannot hold a total budget.
 * When the deadline passes mid-loop the agent stops calling tools and makes one
 * final text-only call, which turns "slow" into "slightly less researched" rather
 * than into silence.
 */
const TURN_DEADLINE_MS = 5_000;
const MODEL_TIMEOUT_MS = 8_000;
/** Grace for the forced final call, so a deadline overrun still yields a reply. */
const FINAL_CALL_MS = 4_000;

export interface TurnResult {
  outcome: DeliveryOutcome | { status: 'no_reply'; reason: string };
  iterations: number;
  latencyMs: number;
  ledger: TurnLedger;
  draft: string | null;
}

export async function runShopperTurn(params: {
  merchantId: string;
  conversationId: string;
  customerId: string;
}): Promise<TurnResult> {
  const startedAt = Date.now();
  const ledger = emptyLedger();

  const context = await loadContext(params);
  if (!context) {
    return {
      outcome: { status: 'no_reply', reason: 'context unavailable' },
      iterations: 0,
      latencyMs: Date.now() - startedAt,
      ledger,
      draft: null,
    };
  }

  const toolContext: ToolContext = {
    merchantId: params.merchantId,
    conversationId: params.conversationId,
    customerId: params.customerId,
    config: context.config,
    ledger,
  };

  const messages: ChatMessage[] = [
    { role: 'system', content: buildShopperSystemPrompt(context) },
    ...context.history.map((message) => ({
      role: message.direction === 'inbound' ? ('user' as const) : ('assistant' as const),
      content: message.content,
    })),
  ];

  let iterations = 0;
  let draft: string | null = null;

  while (iterations < MAX_ITERATIONS) {
    iterations += 1;

    const elapsed = Date.now() - startedAt;
    const outOfTime = elapsed > TURN_DEADLINE_MS;

    let completion;
    try {
      completion = await complete({
        messages,
        // Out of time: drop the tools so the model has to answer with what it
        // already looked up. The guardrails still hold — an unfounded price is
        // blocked whether or not the agent was in a hurry.
        tools: outOfTime ? undefined : SHOPPER_TOOL_DEFINITIONS,
        timeoutMs: outOfTime
          ? FINAL_CALL_MS
          : Math.max(2_000, Math.min(MODEL_TIMEOUT_MS, TURN_DEADLINE_MS - elapsed + FINAL_CALL_MS)),
      });
    } catch (error) {
      const message = error instanceof LLMError ? error.message : String(error);
      await logEvent(params.merchantId, 'agent.model_failed', {
        conversationId: params.conversationId,
        iteration: iterations,
        message,
      });
      // Silence is the worst outcome for a waiting shopper, but a wrong answer is
      // worse still. Hand to the merchant rather than improvising.
      await escalateForFailure(params, 'The assistant could not produce a reply.');
      return {
        outcome: { status: 'no_reply', reason: 'model unavailable' },
        iterations,
        latencyMs: Date.now() - startedAt,
        ledger,
        draft: null,
      };
    }

    await logEvent(params.merchantId, 'agent.iteration', {
      conversationId: params.conversationId,
      iteration: iterations,
      toolCalls: completion.toolCalls.map((call) => call.name),
      latencyMs: completion.latencyMs,
      producedText: Boolean(completion.text),
      pastDeadline: outOfTime,
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

      // Sequential rather than parallel: these are cheap indexed queries against
      // our own tables, and a later tool may depend on an earlier one's writes.
      for (const call of completion.toolCalls) {
        const result = await executeTool(call.name, call.arguments, toolContext);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }

      continue;
    }

    if (completion.text) {
      draft = completion.text;
      break;
    }

    // No text and no tool calls — nothing more to do.
    break;
  }

  if (!draft) {
    const reason =
      iterations >= MAX_ITERATIONS ? 'iteration limit reached' : 'model returned nothing to say';
    await logEvent(params.merchantId, 'agent.no_draft', {
      conversationId: params.conversationId,
      reason,
      iterations,
    });
    await escalateForFailure(params, 'The assistant could not settle on a reply.');
    return {
      outcome: { status: 'no_reply', reason },
      iterations,
      latencyMs: Date.now() - startedAt,
      ledger,
      draft: null,
    };
  }

  // Stage 4 inserts the eight guardrails here, between the draft and delivery.
  const outcome = await deliverReply({
    merchantId: params.merchantId,
    conversationId: params.conversationId,
    text: draft,
    kind: 'reply',
    toolCalls: summariseLedger(ledger),
  });

  const latencyMs = Date.now() - startedAt;
  await logEvent(params.merchantId, 'agent.turn_completed', {
    conversationId: params.conversationId,
    iterations,
    latencyMs,
    outcome: outcome.status,
  });

  return { outcome, iterations, latencyMs, ledger, draft };
}

// ---------------------------------------------------------------------------

async function loadContext(params: {
  merchantId: string;
  conversationId: string;
  customerId: string;
}): Promise<ShopperContext | null> {
  const db = supabaseAdmin();

  // One round trip each, in parallel — this sits inside the five-second budget.
  const [merchant, config, customer, conversation, skills, history] = await Promise.all([
    db.from('merchants').select('business_name').eq('id', params.merchantId).single(),
    db
      .from('agent_configs')
      .select(
        'brand_voice, voice_examples, discount_floor_pct, escalation_rules, auto_send, active_hours, shipping_policy, returns_policy'
      )
      .eq('merchant_id', params.merchantId)
      .single(),
    db
      .from('customers')
      .select('id, handle, name, size, preferences, budget_range, lifetime_value_cents')
      .eq('id', params.customerId)
      .single(),
    db.from('conversations').select('source').eq('id', params.conversationId).single(),
    // Global skills (merchant_id null) plus this merchant's own.
    db
      .from('skills')
      .select('name, content, merchant_id')
      .or(`merchant_id.eq.${params.merchantId},merchant_id.is.null`)
      .eq('enabled', true)
      .order('created_at', { ascending: true }),
    db
      .from('messages')
      .select('direction, sender, content, status')
      .eq('conversation_id', params.conversationId)
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT),
  ]);

  if (merchant.error || config.error || customer.error || conversation.error) {
    console.error('[agent] could not load context', {
      merchant: merchant.error,
      config: config.error,
      customer: customer.error,
      conversation: conversation.error,
    });
    return null;
  }

  return {
    merchantId: params.merchantId,
    businessName: merchant.data.business_name ?? 'the shop',
    conversationId: params.conversationId,
    customer: {
      ...customer.data,
      preferences: (customer.data.preferences ?? {}) as Record<string, unknown>,
    },
    config: config.data,
    skills: (skills.data ?? []).map((skill) => ({ name: skill.name, content: skill.content })),
    history: (history.data ?? [])
      // A draft awaiting approval, or one a guardrail blocked, was never seen by
      // the shopper. Including it would have the agent refer back to something
      // that does not exist in their inbox.
      .filter((message) => message.status === 'sent')
      .reverse()
      .map((message) => ({
        direction: message.direction as 'inbound' | 'outbound',
        sender: message.sender as 'customer' | 'agent' | 'merchant',
        content: message.content,
      })),
    source: (conversation.data.source ?? 'dm') as 'dm' | 'comment' | 'story_reply',
  };
}

async function escalateForFailure(
  params: { merchantId: string; conversationId: string },
  reason: string
): Promise<void> {
  await supabaseAdmin()
    .from('conversations')
    .update({ status: 'escalated' })
    .eq('id', params.conversationId)
    .eq('merchant_id', params.merchantId);

  await logEvent(params.merchantId, 'conversation.escalated', {
    conversationId: params.conversationId,
    reason,
  });
}

/** A compact audit trail of what the tools established, stored on the message. */
function summariseLedger(ledger: TurnLedger) {
  return {
    pricesCents: [...ledger.pricesCents],
    availableVariantIds: [...ledger.availableVariantIds],
    unavailableVariantIds: [...ledger.unavailableVariantIds],
    policies: [...ledger.policies.keys()],
    escalation: ledger.escalation,
  };
}
