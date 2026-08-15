import { supabaseAdmin } from './supabase/admin';
import { logEvent } from './log';
import { checkProactiveLimits } from './limits';
import { messagingWindowState } from './messaging';
import { deliverReply } from './agent/deliver';
import { emptyLedger } from './agent/types';
import { getAgentConfig } from './merchants';

/**
 * Executing what the merchant confirmed (BUILD_SPEC §4.5).
 *
 * Nothing here trusts the operator agent's word for what it proposed — the task
 * row is re-read and re-validated at execution time. The agent proposes; this
 * applies. Keeping those apart is what makes "preview, confirm, execute" mean
 * something rather than being a delay before the same action.
 */

export interface PendingTask {
  id: string;
  request: string;
  interpretation: string | null;
  actionType: 'query' | 'one_off' | 'rule' | 'correction';
  payload: Record<string, unknown>;
  createdAt: string;
}

export async function getPendingTasks(merchantId: string): Promise<PendingTask[]> {
  const { data } = await supabaseAdmin()
    .from('operator_tasks')
    .select('id, request, interpretation, action_type, payload, created_at')
    .eq('merchant_id', merchantId)
    .eq('status', 'pending_confirm')
    .order('created_at', { ascending: false })
    .limit(20);

  return (data ?? []).map((row) => ({
    id: row.id,
    request: row.request,
    interpretation: row.interpretation,
    actionType: row.action_type as PendingTask['actionType'],
    payload: (row.payload ?? {}) as Record<string, unknown>,
    createdAt: row.created_at,
  }));
}

export type ExecutionResult = { ok: true; summary: string } | { ok: false; error: string };

export async function executeTask(merchantId: string, taskId: string): Promise<ExecutionResult> {
  const db = supabaseAdmin();

  const { data: task } = await db
    .from('operator_tasks')
    .select('id, action_type, payload, status')
    .eq('id', taskId)
    .eq('merchant_id', merchantId)
    .maybeSingle();

  if (!task) return { ok: false, error: 'That request is no longer here.' };
  if (task.status !== 'pending_confirm') return { ok: false, error: 'That was already dealt with.' };

  const payload = (task.payload ?? {}) as Record<string, unknown>;

  try {
    const result =
      task.action_type === 'rule'
        ? await applyConfigChange(merchantId, payload)
        : task.action_type === 'one_off'
          ? await sendMessageBatch(merchantId, payload)
          : { ok: false as const, error: 'Nothing to do for that request.' };

    if (!result.ok) return result;

    await db
      .from('operator_tasks')
      .update({ status: 'executed', executed_at: new Date().toISOString() })
      .eq('id', taskId);

    await logEvent(merchantId, 'operator_task.executed', {
      taskId,
      actionType: task.action_type,
    });

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logEvent(merchantId, 'operator_task.failed', { taskId, message });
    return { ok: false, error: message };
  }
}

export async function rejectTask(merchantId: string, taskId: string): Promise<void> {
  await supabaseAdmin()
    .from('operator_tasks')
    .update({ status: 'rejected' })
    .eq('id', taskId)
    .eq('merchant_id', merchantId)
    .eq('status', 'pending_confirm');

  await logEvent(merchantId, 'operator_task.rejected', { taskId });
}

// ---------------------------------------------------------------------------

/** The field allowlist is re-checked here, not trusted from the stored payload. */
const SETTABLE_FIELDS = new Set([
  'brand_voice',
  'discount_floor_pct',
  'escalation_rules',
  'auto_send',
  'shipping_policy',
  'returns_policy',
]);

const SYSTEM_DISCOUNT_CEILING = 50;

async function applyConfigChange(
  merchantId: string,
  payload: Record<string, unknown>
): Promise<ExecutionResult> {
  const field = typeof payload.field === 'string' ? payload.field : '';
  if (!SETTABLE_FIELDS.has(field)) {
    return { ok: false, error: 'That setting cannot be changed here.' };
  }

  let value = payload.value;

  // Re-clamped at execution. A ceiling that only existed when the proposal was
  // written would not be a ceiling.
  if (field === 'discount_floor_pct') {
    const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
    if (!Number.isFinite(parsed)) return { ok: false, error: 'That is not a valid percentage.' };
    value = Math.max(0, Math.min(SYSTEM_DISCOUNT_CEILING, Math.round(parsed)));
  }

  const { error } = await supabaseAdmin()
    .from('agent_configs')
    .update({ [field]: value, updated_at: new Date().toISOString() })
    .eq('merchant_id', merchantId);

  if (error) return { ok: false, error: error.message };

  return { ok: true, summary: 'Done — the agent uses this from its next conversation.' };
}

/**
 * Sends a confirmed batch, one recipient at a time, with every per-recipient
 * check applied again: the messaging window, the weekly per-customer cap, the
 * daily proactive cap. A confirmation is permission to send to people who can be
 * sent to — not a bypass.
 */
async function sendMessageBatch(
  merchantId: string,
  payload: Record<string, unknown>
): Promise<ExecutionResult> {
  const draft = typeof payload.draft === 'string' ? payload.draft.trim() : '';
  const recipients = Array.isArray(payload.recipients) ? payload.recipients : [];

  if (!draft) return { ok: false, error: 'There is no message to send.' };
  if (!recipients.length) return { ok: false, error: 'There is nobody to send it to.' };

  const db = supabaseAdmin();
  const config = await getAgentConfig(merchantId);

  let sent = 0;
  let queued = 0;
  let skipped = 0;

  for (const entry of recipients) {
    const customerId = (entry as { customerId?: string })?.customerId;
    if (!customerId) {
      skipped += 1;
      continue;
    }

    // Only into a conversation that already exists. Someone who has never
    // messaged the shop has no thread and cannot legally be opened one.
    const { data: conversation } = await db
      .from('conversations')
      .select('id, last_inbound_at')
      .eq('merchant_id', merchantId)
      .eq('customer_id', customerId)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    if (!conversation) {
      skipped += 1;
      continue;
    }

    if (
      messagingWindowState(
        conversation.last_inbound_at ? new Date(conversation.last_inbound_at) : null
      ).state === 'closed'
    ) {
      skipped += 1;
      continue;
    }

    const limit = await checkProactiveLimits({ merchantId, customerId });
    if (!limit.allowed) {
      skipped += 1;
      continue;
    }

    const outcome = await deliverReply({
      merchantId,
      conversationId: conversation.id,
      text: draft,
      kind: 'operator_batch',
      // No tool established anything here, so the guardrails treat every figure
      // in the merchant's own draft as unfounded. That is the right answer: a
      // price typed into a batch is not a price anything checked.
      ledger: emptyLedger(),
      config,
    });

    if (outcome.status === 'sent') sent += 1;
    else if (outcome.status === 'queued') queued += 1;
    else skipped += 1;
  }

  await logEvent(merchantId, 'operator_batch.sent', { sent, queued, skipped });

  const parts = [`Sent to ${sent}`];
  if (queued) parts.push(`${queued} waiting in Approvals`);
  if (skipped) parts.push(`${skipped} skipped (too long since they last wrote, or messaged recently)`);

  return { ok: true, summary: `${parts.join(' · ')}.` };
}
