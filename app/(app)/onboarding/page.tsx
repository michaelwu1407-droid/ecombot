import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentMerchant } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { connectInstagram } from '@/lib/connections';
import {
  getOnboardingState,
  ingestVoiceFromProvider,
  mergeVoiceExamples,
  selectVoiceExamples,
  goLive,
  type OnboardingState,
} from '@/lib/onboarding';

/**
 * Onboarding wizard (BUILD_SPEC §4.7 step 10, §2.8 screen 6).
 *
 * Done when a new merchant goes from signup to live agent without anyone
 * touching the database. The founder guides them through it personally (§1.1),
 * so this is a checklist they work down together, not a self-service funnel.
 *
 * Going live is the last step and it is deliberate. Nothing sends until they
 * press it — and even then, suggest mode holds every reply.
 */

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; done?: string }>;
}) {
  const params = await searchParams;
  const merchant = await currentMerchant();
  if (!merchant) redirect('/login');

  const state = await getOnboardingState(merchant.id);

  async function saveInstagram(formData: FormData) {
    'use server';
    const active = await currentMerchant();
    if (!active) redirect('/login');

    const accountId = String(formData.get('provider_account_id') ?? '').trim();
    if (!accountId) redirect('/onboarding?error=' + encodeURIComponent('Enter the account id.'));

    await connectInstagram({ merchantId: active.id, providerAccountId: accountId });
    revalidatePath('/onboarding');
    redirect('/onboarding?done=' + encodeURIComponent('Instagram connected.'));
  }

  async function importVoice() {
    'use server';
    const active = await currentMerchant();
    if (!active) redirect('/login');

    const result = await ingestVoiceFromProvider(active.id);
    revalidatePath('/onboarding');

    redirect(
      '/onboarding?done=' +
        encodeURIComponent(
          result.imported > 0
            ? `Read ${result.imported} of your replies.`
            : 'Nothing to import yet — paste a few replies below instead.'
        )
    );
  }

  async function savePastedVoice(formData: FormData) {
    'use server';
    const active = await currentMerchant();
    if (!active) redirect('/login');

    // One reply per line is how a person naturally pastes this.
    const examples = selectVoiceExamples(String(formData.get('examples') ?? '').split('\n'));
    if (!examples.length) {
      redirect('/onboarding?error=' + encodeURIComponent('Those were too short to learn from.'));
    }

    await mergeVoiceExamples(active.id, examples);
    revalidatePath('/onboarding');
    redirect('/onboarding?done=' + encodeURIComponent(`Saved ${examples.length} examples.`));
  }

  async function activate() {
    'use server';
    const active = await currentMerchant();
    if (!active) redirect('/login');

    const result = await goLive(active.id);
    revalidatePath('/onboarding');

    if (!result.ok) redirect(`/onboarding?error=${encodeURIComponent(result.error ?? 'Not ready yet.')}`);
    redirect('/dashboard');
  }

  async function pause() {
    'use server';
    const active = await currentMerchant();
    if (!active) redirect('/login');

    await supabaseAdmin().from('merchants').update({ status: 'paused' }).eq('id', active.id);
    revalidatePath('/onboarding');
    redirect('/onboarding?done=' + encodeURIComponent('Paused. The agent will not reply to anyone.'));
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-xl font-semibold tracking-tight">Getting set up</h1>
      <p className="mt-1 text-sm text-muted">
        Five things, then your agent is live. Nothing sends to a customer until you say so.
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

      <ol className="mt-8 flex flex-col gap-6">
        <Step n={1} title="Connect Instagram" done={state.instagram}>
          {state.instagram ? (
            <p className="text-sm text-muted">Connected.</p>
          ) : (
            <form action={saveInstagram} className="flex flex-col gap-2">
              <p className="text-sm text-muted">
                Your account manager sets this up and gives you the account id to paste here.
              </p>
              <div className="flex gap-2">
                <input
                  name="provider_account_id"
                  required
                  placeholder="Account id"
                  className="flex-1 rounded-md border border-line px-3 py-2 text-sm outline-none focus:border-accent"
                />
                <button className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-white">
                  Connect
                </button>
              </div>
            </form>
          )}
        </Step>

        <Step n={2} title="Connect Shopify" done={state.shopify}>
          <p className="text-sm text-muted">
            {state.shopify
              ? 'Connected, and your catalogue is in sync.'
              : 'The agent answers about price and stock from your live catalogue, so it never guesses.'}
          </p>
          <Link
            href="/settings/connections"
            className="mt-2 inline-block text-sm text-accent hover:underline"
          >
            {state.shopify ? 'Manage' : 'Connect Shopify'}
          </Link>
        </Step>

        <Step n={3} title="Teach it your voice" done={state.voice}>
          <p className="text-sm text-muted">
            This is the part that matters most. Your customers should not be able to tell.
          </p>

          <form action={importVoice} className="mt-3">
            <button className="rounded-md border border-line px-4 py-2 text-sm font-medium">
              Read my past replies
            </button>
          </form>

          <form action={savePastedVoice} className="mt-4 flex flex-col gap-2">
            <label className="text-sm text-muted" htmlFor="examples">
              Or paste a few replies you have written — one per line.
            </label>
            <textarea
              id="examples"
              name="examples"
              rows={4}
              placeholder={'yes we do! it comes in a 10, want me to put one aside?\nhey lovely, that one sold out but more land friday x'}
              className="w-full resize-y rounded-md border border-line px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <button className="self-start rounded-md border border-line px-4 py-2 text-sm font-medium">
              Save examples
            </button>
          </form>
        </Step>

        <Step n={4} title="Set your rules" done={state.policies}>
          <p className="text-sm text-muted">
            Shipping, returns, and how much the agent may ever discount. If a policy is blank it
            fetches you rather than inventing one.
          </p>
          <Link href="/settings" className="mt-2 inline-block text-sm text-accent hover:underline">
            Open settings
          </Link>
        </Step>

        <Step n={5} title="Take payments" done={state.stripe} optional>
          <p className="text-sm text-muted">
            Lets the agent send a payment link in the conversation. Money goes straight to your own
            Stripe account. You can add this later.
          </p>
          <Link
            href="/settings/connections"
            className="mt-2 inline-block text-sm text-accent hover:underline"
          >
            {state.stripe ? 'Manage' : 'Connect Stripe'}
          </Link>
        </Step>
      </ol>

      <section className="mt-12 rounded-lg border border-line bg-surface px-4 py-5">
        {state.live ? (
          <>
            <p className="text-sm font-medium">Your agent is live.</p>
            <p className="mt-1 text-sm text-muted">
              It is drafting replies and holding them for you on the Approvals screen until you
              turn on automatic replies in Settings.
            </p>
            <form action={pause} className="mt-4">
              <button className="rounded-md border border-line px-4 py-2 text-sm font-medium text-secondary">
                Pause the agent
              </button>
            </form>
          </>
        ) : (
          <>
            <p className="text-sm font-medium">
              {state.readyToGoLive ? 'Ready when you are.' : 'Not ready yet.'}
            </p>
            <p className="mt-1 text-sm text-muted">
              {state.readyToGoLive
                ? 'It will start drafting replies to new messages. Every one waits for your approval.'
                : 'Connect Instagram and Shopify, and teach it your voice, first.'}
            </p>
            <form action={activate} className="mt-4">
              <button
                disabled={!state.readyToGoLive}
                className="rounded-md bg-ink px-5 py-2 text-sm font-medium text-white disabled:opacity-40"
              >
                Go live
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}

function Step({
  n,
  title,
  done,
  optional,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-4">
      <span
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium"
        style={
          done
            ? { borderColor: 'var(--color-good)', color: 'var(--color-good)' }
            : { borderColor: 'var(--color-line)', color: 'var(--color-muted)' }
        }
        aria-hidden
      >
        {done ? '✓' : n}
      </span>
      <div className="flex-1">
        <h2 className="text-base font-medium">
          {title}
          {optional && <span className="ml-2 text-xs font-normal text-muted">optional</span>}
          <span className="sr-only">{done ? ' — done' : ' — not done'}</span>
        </h2>
        <div className="mt-1">{children}</div>
      </div>
    </li>
  );
}

export type { OnboardingState };
