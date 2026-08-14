# Build log

Running record of what is built, what deviated from `BUILD_SPEC.md`, and what needs a
founder decision. Structured around §4.10 ("Report back on").

---

## Stage 0 — Provider verification (the Day 1 blocker)

§4.2 makes this a hard gate: confirm the bridge provider supports inbound webhooks,
comment events, and per-merchant account connection. If it only sends, the plan
changes.

**Provider: Zernio.** All three clear.

| Requirement | Verdict | Evidence |
|---|---|---|
| Inbound webhooks, not only outbound | Yes | `message.received`, `conversation.started`, `message.sent`, `message.delivered`, `message.read`, `message.failed` |
| Comment events | Yes | `comment.received` as a first-class webhook, carrying `comment.id`, `platformPostId`, author id and handle. Not merely their no-code keyword-automation product, which would have been unusable — we need our own intent check, not their keyword matcher |
| Per-merchant account connection | Yes | A profile per customer, OAuth via `/v1/connect/instagram?profileId=…`, and `account.id` on every inbound payload for routing |

Supporting facts the adapter is built on:

- Send: `POST /v1/inbox/conversations` with `{accountId, participantId, message}` opens
  the thread if there is not one and sends in a single call.
- Private reply: `POST /v1/inbox/comments/{postId}/{commentId}/private-reply`.
- Webhook signature: HMAC-SHA256, lowercase hex, `X-Zernio-Signature`.
- Delivery is at-least-once with 7 retries over ~27 hours; the event `id` is the
  dedupe key; a response slower than 5 seconds counts as a failure.

### Flag: Instagram's messaging window constrains §2.5 more than the spec assumed

Not a Zernio limitation — Meta's rule, and it would apply identically after migrating
to Meta direct.

- **0-24h** from the customer's last message: send anything.
- **24h-7d**: deliverable only under the `HUMAN_AGENT` tag, the sole tag Instagram
  supports. Meta scopes that tag to messages a human agent is handling.
- **After 7 days**: no route exists.

Both proactive features in §2.5 sit on the wrong side of this:

- **Dead thread revival** fires at 24h+ stale, i.e. exactly at the boundary. Sweeping
  at 4-hourly intervals means most candidates are already past 24 hours.
- **Restock notification** fires whenever stock returns — routinely days later.

Sending either automatically under `HUMAN_AGENT` is a policy violation, and the
consequence is the one risk §1.7 names as fatal: a restricted merchant account.

**Implemented for now:** `lib/messaging/window.ts` computes the window state, and
`isWithinMessagingWindow()` returns true only inside 24 hours. Stage 7 will route
anything in the 24h-7d band into the merchant's approval queue rather than sending it
unattended, so the tag is used for a message a human actually approved.

**Decided:** merchant one-tap approval for anything in the 24h-7d band. Verified
against Meta's own developer documentation before committing to it.

### Follow-up verification: is there a workaround?

Checked properly rather than assumed. Three mechanisms exist; only one is available
to us today.

| Mechanism | Status | Usable now? |
|---|---|---|
| Standard 24h window | Current | Yes — covers all reactive replies |
| `HUMAN_AGENT` tag, 24h → 7d | Current, but Meta scopes it to messages a human is handling | Only behind merchant approval |
| Marketing Messages API — topic opt-in inside the window, then send outside it | Replaced the Recurring Notifications API on 10 Feb 2026 | **No — the bridge provider does not expose it** |

The third one matters and is worth revisiting. Its shape is an exact fit for the
waitlist: ask the shopper inside the open window whether they want to be told when
the item is back, and their opt-in licenses sending outside the window on that topic
on an ongoing basis. That is precisely §2.4's waitlist and §2.5's restock
notification, done the way Meta wants it done — no tag stretching, no policy risk.

The bridge provider has no opt-in or marketing-message surface for Instagram (their
opt-in tooling is SMS and WhatsApp only). So it is not reachable today. It becomes
reachable either when they add it or when we migrate to Meta direct.

Limits to design against when it does: one marketing message per subscriber per
48 hours, one message per opt-in, at most one opt-in request per user per week per
topic, and the message must match the topic opted into. A restock notification fits
inside all four.

**Implication for the roadmap:** restock notification is merchant-approved now and
becomes fully automatic later, without a product redesign. Worth raising with the
bridge provider — it may be a feature request rather than a migration.

---

## Stage 1 — Foundation

**Done when:** a DM to the test account appears as a row in `messages`.

### Shipped

- Next.js 15 App Router + TypeScript, Tailwind v4, builds clean.
- Full schema (`supabase/migrations/0001_init.sql`) with row-level security on every
  table. Reads go through the user's client and are RLS-filtered; all writes go
  through the service-role client, which is why no write policies are granted.
- Supabase email/password auth, merchant signup provisioning a `merchants` row and an
  `agent_configs` row with `auto_send = false` — suggest mode by default (§3.4).
- `lib/messaging/`: the interface, the Zernio adapter, the Meta stub, an in-memory
  mock, and the messaging-window rules.
- `POST /api/webhooks/messaging`: signature verified against raw bytes, event parsed,
  deduped, ingested into `customers` / `conversations` / `messages`.
- AES-256-GCM encryption for `connections.credentials`.
- 27 unit tests covering event parsing, messaging windows, encryption and signature
  verification. No network or credentials needed.

### Verification status

The "done when" criterion needs a live Instagram account and Zernio credentials, which
this environment does not have. What is verified instead: the adapter is written
against payload shapes taken from the provider's own documentation, and the parser is
tested against those shapes — including the cases that matter operationally (outbound
echoes, attachment-only messages, non-Instagram platforms sharing the endpoint,
malformed payloads, and a comment with no post id, which could never be replied to).
End-to-end confirmation is outstanding until credentials exist.

### Deviations from the spec

All additive; nothing specced was dropped.

| Deviation | Why |
|---|---|
| `MessagingProvider.sendPrivateReplyToComment` takes an optional 4th argument, `postId` | Zernio addresses the endpoint as `/comments/{postId}/{commentId}/private-reply`. Optional, so the spec's three-argument call still compiles. Meta direct keys off the comment alone and will ignore it |
| `InboundEvent` gains `postId`, `providerConversationId`, `senderName`, `isReply` | Without `postId` a comment cannot be answered at all; without the conversation id a reply cannot be threaded |
| `merchants.auth_user_id` | RLS needs a link to `auth.uid()`. Matching on email would be fragile |
| `platform_admins` table | The founder views (§2.8 screens 7-8) need a role that reads across merchants |
| `conversations.provider_conversation_id`, `.participant_id`, `.last_inbound_at` | Threading a reply, and measuring the 24-hour messaging window |
| `webhook_events` table | Provider delivery is at-least-once. Without a dedupe key a retry sends the customer a second reply |
| `send_log` table | Rate limits and daily caps have to be enforced in code (§1.7), which needs a durable counter |
| `tests/resolve-hook.mjs` | Lets `node --test` run the app's TypeScript directly. The alternative was adding a test framework — see below |

### Dependencies I was tempted to add, and did not (§4.10)

- **A test framework (vitest/jest).** Avoided. `node --test` plus a 40-line resolve
  hook using Node's built-in `module.registerHooks` runs the real modules with no
  dependency. Worth revisiting only if the hook starts costing more than it saves.
- **A schema validator (zod).** Avoided. Webhook payloads are parsed by hand in
  `lib/messaging/providers/zernio.ts` — small shapes, and anything unrecognised
  returns `null` rather than throwing. I expect to want it again for operator-agent
  tool arguments in stage 9; will flag rather than add.
- **A queue.** Explicitly forbidden, and not needed: Next's `after()` keeps the
  function alive past the response, which is what the sub-five-second reply budget
  actually requires.

### Review pass — problems found and fixed before commit

- **Claimed-then-failed events were unrecoverable.** The dedupe claim was taken before
  processing, so a transient database failure looked permanently like a message that
  never arrived. Restructured: ingestion now runs *before* the response, so a failure
  returns non-2xx and earns a real provider retry, and the claim is released on
  failure. Only the agent turn runs in `after()`.
- **Conversation reuse would have broken sale attribution.** Any live thread was
  reused regardless of age, so a returning shopper's comment would fold into their old
  DM thread and the sale would be credited to `dm`, losing the trace back to the post
  that earned it — the exact link §4.9 asks the merchant to follow. Reuse is now capped
  at 24 hours.

---

## Stage 2 — Commerce

**Done when:** the catalogue is queryable and stock matches the Shopify admin.

### Shipped

- Shopify Admin GraphQL client over plain fetch — no SDK, per §4.1. Handles the
  cost-based throttling with backoff, and distinguishes a dead token (fail, tell the
  merchant) from a transient error (retry).
- Catalogue sync into `products`, paginated across products and variants, storing
  integer cents throughout.
- Hourly cron at `/api/cron/product-sync`, authenticated with a bearer secret because
  cron paths are public URLs.
- Connect screen: the merchant pastes a custom app token, it is verified against the
  live API before being stored, encrypted, and the first sync runs immediately rather
  than leaving them to wait an hour.
- 8 more tests (35 total): money conversion and shop-domain normalisation.

### Decisions

- **Custom app token, not a public Shopify OAuth app.** Merchants are onboarded
  personally by the founder (§1.1), so a public app would mean sitting in a second
  review queue for no gain.
- **Trust `availableForSale` over the raw inventory count.** A merchant who oversells
  deliberately shows available at zero stock; second-guessing that would make the
  agent refuse real sales.
- **Vanished variants are marked unavailable, not deleted.** Waitlist entries and past
  conversations keep their references, so history stays intact.

### Verification status

Same as stage 1: no live Shopify store in this environment. The client is written
against the documented GraphQL Admin API, and the pure logic — money conversion,
domain normalisation, retry classification — is tested. Stock parity with a real
admin is outstanding until a store is connected.

### Next

Stage 3 — the shopper agent: tools, the loop, and the base prompt.
