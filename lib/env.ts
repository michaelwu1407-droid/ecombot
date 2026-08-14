/**
 * Environment access with a single failure mode: a missing variable throws at the
 * point of use, naming itself. Nothing here reads process.env at module scope, so
 * importing a module never fails a build for a variable that code path doesn't use.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const env = {
  supabaseUrl: () => required('NEXT_PUBLIC_SUPABASE_URL'),
  supabaseAnonKey: () => required('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  supabaseServiceRoleKey: () => required('SUPABASE_SERVICE_ROLE_KEY'),

  messagingProvider: () => optional('MESSAGING_PROVIDER', 'zernio'),
  messagingApiKey: () => required('MESSAGING_PROVIDER_API_KEY'),
  messagingWebhookSecret: () => required('MESSAGING_WEBHOOK_SECRET'),

  openRouterApiKey: () => required('OPENROUTER_API_KEY'),
  /**
   * Pinned, never 'auto' (§3.6). Auto-routing gives inconsistent tone, variable
   * tool-calling reliability and unpredictable cost — unacceptable for a sales agent.
   */
  openRouterModel: () => {
    const model = required('OPENROUTER_MODEL');
    if (model.trim().toLowerCase() === 'auto' || model.includes('/auto')) {
      throw new Error("OPENROUTER_MODEL must be a pinned model, never 'auto' (BUILD_SPEC §3.6)");
    }
    return model;
  },

  stripeSecretKey: () => required('STRIPE_SECRET_KEY'),
  stripeWebhookSecret: () => required('STRIPE_WEBHOOK_SECRET'),
  stripeConnectClientId: () => required('STRIPE_CONNECT_CLIENT_ID'),

  encryptionKey: () => required('ENCRYPTION_KEY'),
  cronSecret: () => required('CRON_SECRET'),

  sentryDsn: () => process.env.SENTRY_DSN,
};
