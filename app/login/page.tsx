import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/supabase/server';
import { provisionMerchant } from '@/lib/merchants';

/**
 * Sign in and sign up on one screen. Merchants are onboarded personally by the
 * founder (§1.1), so this is deliberately plain — the guided flow is the
 * onboarding wizard, not this page.
 */

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string; next?: string }>;
}) {
  const params = await searchParams;

  async function signIn(formData: FormData) {
    'use server';
    const email = String(formData.get('email') ?? '').trim();
    const password = String(formData.get('password') ?? '');

    const supabase = await supabaseServer();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);
    redirect('/dashboard');
  }

  async function signUp(formData: FormData) {
    'use server';
    const email = String(formData.get('email') ?? '').trim();
    const password = String(formData.get('password') ?? '');
    const businessName = String(formData.get('business_name') ?? '').trim();

    const supabase = await supabaseServer();
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);

    if (data.user) {
      await provisionMerchant({
        authUserId: data.user.id,
        email,
        businessName: businessName || null,
      });
    }

    // With email confirmation on, there is no session yet.
    if (!data.session) redirect('/login?sent=1');
    redirect('/dashboard');
  }

  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col justify-center gap-8 px-6 py-16">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sales agent</h1>
        <p className="mt-1 text-sm text-muted">Sign in to your dashboard.</p>
      </div>

      {params.error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {params.error}
        </p>
      )}
      {params.sent && (
        <p className="rounded-md border border-line bg-neutral-50 px-3 py-2 text-sm">
          Check your email to confirm your address, then sign in.
        </p>
      )}

      <form className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5 text-sm">
          Email
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            className="rounded-md border border-line px-3 py-2 text-base outline-none focus:border-accent"
          />
        </label>

        <label className="flex flex-col gap-1.5 text-sm">
          Password
          <input
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete="current-password"
            className="rounded-md border border-line px-3 py-2 text-base outline-none focus:border-accent"
          />
        </label>

        <label className="flex flex-col gap-1.5 text-sm">
          Business name <span className="text-muted">(new accounts only)</span>
          <input
            name="business_name"
            type="text"
            className="rounded-md border border-line px-3 py-2 text-base outline-none focus:border-accent"
          />
        </label>

        <div className="mt-2 flex gap-3">
          <button
            formAction={signIn}
            className="flex-1 rounded-md bg-ink px-4 py-2 text-sm font-medium text-white"
          >
            Sign in
          </button>
          <button
            formAction={signUp}
            className="flex-1 rounded-md border border-line px-4 py-2 text-sm font-medium"
          >
            Create account
          </button>
        </div>
      </form>
    </main>
  );
}
