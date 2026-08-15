import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentMerchant } from '@/lib/supabase/server';
import { getPendingReplies, approveReply, dismissReply, type PendingReply } from '@/lib/escalations';

/**
 * Approvals (BUILD_SPEC §2.8 screen 2).
 *
 * Deliberately called "Approvals", not "Escalations". The merchant-facing framing
 * is drafts waiting for her, because in suggest mode almost everything lands here
 * and calling that queue "escalations" would make a working agent look broken.
 */

export default async function EscalationsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const merchant = await currentMerchant();
  if (!merchant) redirect('/login');

  const pending = await getPendingReplies(merchant.id);

  async function approve(formData: FormData) {
    'use server';
    const active = await currentMerchant();
    if (!active) redirect('/login');

    const result = await approveReply({
      merchantId: active.id,
      messageId: String(formData.get('message_id')),
      editedText: String(formData.get('draft') ?? ''),
    });

    revalidatePath('/escalations');
    if (!result.ok) redirect(`/escalations?error=${encodeURIComponent(result.error)}`);
  }

  async function dismiss(formData: FormData) {
    'use server';
    const active = await currentMerchant();
    if (!active) redirect('/login');

    await dismissReply(active.id, String(formData.get('message_id')));
    revalidatePath('/escalations');
  }

  const needsAttention = pending.filter((reply) => reply.status === 'blocked');
  const drafts = pending.filter((reply) => reply.status === 'pending_approval');

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Approvals</h1>
        <span className="text-sm text-muted">
          {pending.length === 0 ? 'All clear' : `${pending.length} waiting`}
        </span>
      </div>

      {params.error && (
        <p className="mt-6 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {params.error}
        </p>
      )}

      {pending.length === 0 && (
        <p className="mt-8 rounded-lg border border-line bg-surface px-4 py-10 text-center text-sm text-muted">
          Nothing waiting. Drafts appear here as shoppers message you.
        </p>
      )}

      {needsAttention.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-medium text-secondary">Needs you</h2>
          <p className="mt-1 text-sm text-muted">
            The agent stopped itself on these. Read the reason before sending.
          </p>
          <div className="mt-4 flex flex-col gap-4">
            {needsAttention.map((reply) => (
              <ReplyCard key={reply.messageId} reply={reply} approve={approve} dismiss={dismiss} />
            ))}
          </div>
        </section>
      )}

      {drafts.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-medium text-secondary">Ready to send</h2>
          <div className="mt-4 flex flex-col gap-4">
            {drafts.map((reply) => (
              <ReplyCard key={reply.messageId} reply={reply} approve={approve} dismiss={dismiss} />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

function ReplyCard({
  reply,
  approve,
  dismiss,
}: {
  reply: PendingReply;
  approve: (formData: FormData) => Promise<void>;
  dismiss: (formData: FormData) => Promise<void>;
}) {
  return (
    <article className="rounded-lg border border-line">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <Link href={`/customers/${reply.customerId}`} className="text-sm font-medium hover:text-accent">
          {reply.handle ? `@${reply.handle}` : (reply.name ?? 'Unknown shopper')}
        </Link>
        <span className="text-xs text-muted">{SOURCE_LABELS[reply.source] ?? reply.source}</span>
      </header>

      {reply.lastCustomerMessage && (
        <div className="border-b border-line bg-surface px-4 py-3">
          <p className="text-xs text-muted">They said</p>
          <p className="mt-1 text-sm text-secondary">{reply.lastCustomerMessage}</p>
        </div>
      )}

      {reply.blockedReason && (
        // Status colour never carries the meaning alone — the icon and the
        // sentence say it too.
        <p
          className="flex items-start gap-2 border-b border-line px-4 py-2.5 text-sm"
          style={{ color: 'var(--color-critical)' }}
        >
          <span aria-hidden>⚠</span>
          <span>{reply.blockedReason}</span>
        </p>
      )}

      <form className="px-4 py-3">
        <input type="hidden" name="message_id" value={reply.messageId} />
        <label className="sr-only" htmlFor={`draft-${reply.messageId}`}>
          Draft reply
        </label>
        <textarea
          id={`draft-${reply.messageId}`}
          name="draft"
          defaultValue={reply.draft}
          rows={3}
          className="w-full resize-y rounded-md border border-line px-3 py-2 text-sm outline-none focus:border-accent"
        />

        <div className="mt-3 flex items-center gap-2">
          <button
            formAction={approve}
            className="rounded-md bg-ink px-4 py-1.5 text-sm font-medium text-white"
          >
            Send
          </button>
          <button
            formAction={dismiss}
            className="rounded-md border border-line px-4 py-1.5 text-sm font-medium text-secondary"
          >
            Dismiss
          </button>
          <span className="ml-auto text-xs text-muted">Edit before sending if you like</span>
        </div>
      </form>
    </article>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  dm: 'Direct message',
  comment: 'From a comment',
  story_reply: 'Story reply',
};
