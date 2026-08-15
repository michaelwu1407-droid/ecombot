import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { currentMerchant } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { runOperatorTurn } from '@/lib/agent/operator';
import { getPendingTasks, executeTask, rejectTask, type PendingTask } from '@/lib/operator-tasks';

/**
 * The Assistant (BUILD_SPEC §2.8 screen 3).
 *
 * The merchant asks in their own words, and the answer either arrives as text or
 * as a card waiting for one tap. Anything that sends messages or changes how the
 * agent behaves appears as a card — never as a sentence claiming it is done.
 * Seeing what was understood before anything happens is the whole point (§4.5).
 */

const SUGGESTIONS = [
  'How many sales did the agent make this week?',
  'Never discount below 10%',
  'Always ask what occasion it is for',
  "Tell everyone who asked about the linen dress it's back",
];

export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; done?: string }>;
}) {
  const params = await searchParams;
  const merchant = await currentMerchant();
  if (!merchant) redirect('/login');

  const [history, pending] = await Promise.all([
    getRecentExchanges(merchant.id),
    getPendingTasks(merchant.id),
  ]);

  async function ask(formData: FormData) {
    'use server';
    const active = await currentMerchant();
    if (!active) redirect('/login');

    // Bounded: this goes into a model call, and an unbounded field is a way to
    // spend someone else's tokens.
    const request = String(formData.get('request') ?? '').trim().slice(0, 2000);
    if (!request) return;

    await runOperatorTurn({
      merchantId: active.id,
      businessName: active.business_name ?? 'the shop',
      request,
    });

    revalidatePath('/assistant');
  }

  async function confirm(formData: FormData) {
    'use server';
    const active = await currentMerchant();
    if (!active) redirect('/login');

    const result = await executeTask(active.id, String(formData.get('task_id')));
    revalidatePath('/assistant');

    if (!result.ok) redirect(`/assistant?error=${encodeURIComponent(result.error)}`);
    redirect(`/assistant?done=${encodeURIComponent(result.summary)}`);
  }

  async function reject(formData: FormData) {
    'use server';
    const active = await currentMerchant();
    if (!active) redirect('/login');

    await rejectTask(active.id, String(formData.get('task_id')));
    revalidatePath('/assistant');
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-xl font-semibold tracking-tight">Assistant</h1>
      <p className="mt-1 text-sm text-muted">
        Ask about your shop, or tell it how the agent should behave.
      </p>

      {params.done && (
        <p className="mt-6 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
          {params.done}
        </p>
      )}
      {params.error && (
        <p className="mt-6 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {params.error}
        </p>
      )}

      {pending.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-medium text-secondary">Waiting for you</h2>
          <div className="mt-3 flex flex-col gap-3">
            {pending.map((task) => (
              <TaskCard key={task.id} task={task} confirm={confirm} reject={reject} />
            ))}
          </div>
        </section>
      )}

      <section className="mt-10 flex flex-col gap-6">
        {history.length === 0 ? (
          <div className="rounded-lg border border-line bg-surface px-4 py-8">
            <p className="text-sm text-muted">Things people ask:</p>
            <ul className="mt-3 flex flex-col gap-1.5">
              {SUGGESTIONS.map((suggestion) => (
                <li key={suggestion} className="text-sm text-secondary">
                  “{suggestion}”
                </li>
              ))}
            </ul>
          </div>
        ) : (
          history.map((exchange) => (
            <div key={exchange.id} className="flex flex-col gap-2">
              <p className="self-end max-w-[85%] rounded-lg bg-ink px-3 py-2 text-sm text-white">
                {exchange.request}
              </p>
              <p className="max-w-[85%] whitespace-pre-wrap rounded-lg border border-line px-3 py-2 text-sm">
                {exchange.answer}
              </p>
            </div>
          ))
        )}
      </section>

      <form action={ask} className="mt-8 flex gap-2">
        <label className="sr-only" htmlFor="request">
          Ask the assistant
        </label>
        <input
          id="request"
          name="request"
          required
          autoComplete="off"
          maxLength={2000}
          placeholder="Ask anything, or tell it a rule"
          className="flex-1 rounded-md border border-line px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <button className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-white">Send</button>
      </form>
    </main>
  );
}

function TaskCard({
  task,
  confirm,
  reject,
}: {
  task: PendingTask;
  confirm: (formData: FormData) => Promise<void>;
  reject: (formData: FormData) => Promise<void>;
}) {
  const recipients = Array.isArray(task.payload.recipients)
    ? (task.payload.recipients as Array<{ handle: string | null; name: string | null }>)
    : [];
  const draft = typeof task.payload.draft === 'string' ? task.payload.draft : null;

  return (
    <article className="rounded-lg border border-line">
      <header className="border-b border-line px-4 py-2.5">
        <p className="text-xs text-muted">You asked</p>
        <p className="mt-0.5 text-sm text-secondary">“{task.request}”</p>
      </header>

      <div className="px-4 py-3">
        {/* What was understood, shown before anything executes (§4.5). */}
        <p className="text-sm font-medium">{task.interpretation}</p>

        {draft && (
          <p className="mt-3 rounded-md bg-surface px-3 py-2 text-sm text-secondary">{draft}</p>
        )}

        {recipients.length > 0 && (
          <div className="mt-3">
            <p className="text-xs text-muted">
              {recipients.length} {recipients.length === 1 ? 'person' : 'people'}
              {/* Above five, every name is shown before confirming (§4.5). */}
              {recipients.length > 5 ? ' — all listed below' : ''}
            </p>
            <p className="mt-1 text-sm text-secondary">
              {recipients
                .map((recipient) => (recipient.handle ? `@${recipient.handle}` : (recipient.name ?? 'Unknown')))
                .join(', ')}
            </p>
          </div>
        )}

        <form className="mt-4 flex items-center gap-2">
          <input type="hidden" name="task_id" value={task.id} />
          <button
            formAction={confirm}
            className="rounded-md bg-ink px-4 py-1.5 text-sm font-medium text-white"
          >
            {task.actionType === 'one_off' ? 'Send it' : 'Apply it'}
          </button>
          <button
            formAction={reject}
            className="rounded-md border border-line px-4 py-1.5 text-sm font-medium text-secondary"
          >
            No
          </button>
        </form>
      </div>
    </article>
  );
}

async function getRecentExchanges(merchantId: string) {
  const { data } = await supabaseAdmin()
    .from('operator_tasks')
    .select('id, request, interpretation, created_at')
    .eq('merchant_id', merchantId)
    .eq('action_type', 'query')
    .eq('status', 'executed')
    .order('created_at', { ascending: false })
    .limit(10);

  return (data ?? [])
    .reverse()
    .map((row) => ({ id: row.id, request: row.request, answer: row.interpretation ?? '' }));
}
