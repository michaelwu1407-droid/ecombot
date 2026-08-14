# Sales agent

An AI sales agent for social-first boutiques. Works the warm leads a merchant already
generates — DMs, comments, story replies — and converts them into sales the owner did
not have time to close.

Built to `BUILD_SPEC.md`. Section references throughout the code point back to it.

## Stack

Next.js (App Router) on Vercel · Supabase (Postgres + auth) · Zernio (messaging bridge)
· Shopify Admin API · Stripe Connect · OpenRouter with a pinned model · Tailwind ·
Vercel cron.

No Redis, no queue service, no ORM beyond the Supabase client, no state management
library. This has to stay maintainable by a contract developer (§4.1).

## Getting started

```bash
npm install
cp .env.example .env.local     # fill in
npm run dev
```

Apply the schema to a Supabase project:

```bash
supabase db push               # or paste supabase/migrations/0001_init.sql into the SQL editor
```

```bash
npm test                       # unit tests, no network or credentials needed
npm run typecheck
npm run build
```

## Layout

```
app/
  api/webhooks/messaging/      inbound events from the messaging provider
  login/                       sign in and sign up
  dashboard/                   merchant app
lib/
  messaging/                   the provider abstraction — see below
    providers/zernio.ts        bridge provider, live
    providers/meta.ts          Meta direct, stubbed until app review lands
    providers/mock.ts          in-memory, for tests and local runs
    window.ts                  Meta's 24-hour and 7-day messaging windows
  supabase/                    admin (service role, writes) and server (RLS, reads)
  inbound.ts                   provider event -> customer, conversation, message
  crypto.ts                    AES-256-GCM for stored credentials
supabase/migrations/           schema and row-level security
tests/                         node:test, no framework
```

## The one rule that matters most

**No file outside `lib/messaging/` may import a provider SDK or reference a provider
by name.** We launch on a bridge provider because Meta app review takes 3-8 weeks;
when approval lands, swapping to Meta direct must be a one-file change (§3.2, §4.2).
Everything upstream talks to the `MessagingProvider` interface.

## Two things enforced in code, never in prompt

**Guardrails** (§3.3). Models are probabilistic and this runs on the merchant's own
account. A prompt instruction not to invent prices will eventually be violated; a code
check that rejects any dollar figure not returned by a tool will not.

**Rate limits and messaging windows** (§1.7, `lib/messaging/window.ts`). Getting a
merchant's Instagram account restricted takes away their livelihood. Meta allows 24
hours from the customer's last message, then 7 days under a tag scoped to human
agents, then nothing.

## Build state

Stage 1 of 10 (§4.7). See `docs/BUILD_LOG.md` for what is done, what was deviated
from, and what is flagged for the founder.
