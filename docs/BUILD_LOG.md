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

---

## Stage 3 — Shopper agent

**Done when:** "do you have the linen dress in a 10?" returns an accurate reply
grounded in real stock.

### Shipped

- All eight tools, each scoped to the calling merchant and returning structured
  data rather than prose.
- The loop (`lib/agent/run.ts`), max 6 iterations, no framework — plain tool calling
  in our own code, per §3.1.
- The base prompt, carrying every rule §4.4 requires, with the prompt-injection rule
  placed last so it sits closest to the untrusted content.
- `lib/agent/deliver.ts` as the single exit point for anything said to a customer.
- Wired: webhook → ingest → agent → reply.
- 19 more tests (54 total): prompt construction and the model client.

### Decisions

- **Tool arguments that name a customer are ignored.** `get_customer_history` and
  `add_to_waitlist` take a `customerId` in the spec's signature. The model is steered
  by public, untrusted input, so the argument is accepted and then discarded in
  favour of the conversation's own customer. Otherwise a shopper who talks the model
  into passing a different id reads someone else's purchase history.
- **A turn deadline, not just a per-call timeout.** A tool-using turn is at least two
  model round trips, so a per-call timeout cannot hold a total budget. At 5 seconds
  the agent drops its tools and makes one final text-only call: "slow" becomes
  "slightly less researched" rather than silence. Guardrails still apply.
- **Suggest mode carries stage 3 on its own.** Guardrails land in stage 4, and until
  they do nothing auto-sends — `auto_send` defaults to false, which is the spec's own
  default anyway (§3.4). There is no window in which unguarded text can reach a
  shopper.
- **Queued and blocked drafts are excluded from history.** A draft the shopper never
  saw would otherwise have the agent refer back to something absent from their inbox.

### Review pass — problems found and fixed

- **An unusable search query returned five arbitrary products.** If every word was a
  single character, the filter was dropped and the query returned whatever came
  first — so the agent could quote a real price for a product nobody asked about.
  Now returns nothing.
- **Search terms are stripped, not just comma-escaped.** They come from a shopper's
  message: `%` and `_` are ilike wildcards and parens are PostgREST filter syntax.
- **Response time would never have been recorded for a new merchant.** It was
  recorded only when the agent itself sent, but every new merchant is in suggest
  mode, where the agent never sends directly. Moved into the delivery path and
  measured from the first inbound message, so a merchant-approved send records it
  too — which is also the honest number, since the shopper was not answered until
  approval.

### Open, for §4.10

- **Latency is unmeasured.** The turn is instrumented end to end (`agent.turn_completed`
  carries `latencyMs`), but without an OpenRouter key there is no real number yet.
  The structural question is whether two model round trips fit in five seconds on the
  pinned model. If they do not, the deadline logic degrades gracefully rather than
  failing, but the honest answer needs a measurement.

---

## Stage 4 — Guardrails and memory

**Done when:** an invented price is blocked and escalated; a stated size persists to
the customer row.

### Shipped

- All eight guardrails as pure functions in `lib/agent/guardrails.ts`, with 43 tests
  covering each one and their interactions.
- The blocked path: logged, escalated, and queued with the reason attached, so a
  blocked message is never silently dropped (§4.4).
- The one permitted retry — a reply over 500 characters gets a single rewrite at
  brevity, with tools withheld so the rewrite cannot introduce new facts.
- Memory extraction on a cheap model call after the reply has gone out, merged into
  the customer row, never overwriting a known value with null.
- `stalled` conversation transitions and their hourly cron.
- `research` client for Hermes (spec addendum §3.7), wired into the operator agent
  in stage 9.
- 63 more tests (117 total).

### Decisions

- **Prices allow sums and floor-bounded discounts, nothing else.** Strict equality
  would block a bundle quote ("both for $75") and any negotiation at all, and §2.2
  asks for both. Sums are capped at 4 items from 12 looked-up prices — past that the
  combinations stop being a bundle and start being a way to justify any number.
- **Bare numbers are not treated as prices.** "a size 10", "2 left", "3-5 days" are
  all bare numbers, and blocking them would reject almost every legitimate reply.
  The cost is that "it's 45" passes unchecked; the prompt asks for a currency symbol
  and quoting a naked number is not a natural way to answer a price question.
- **A promise is allowed only when the policy was actually read.** If `get_policy`
  ran this turn, the model had the real text and we accept its paraphrase. If not,
  the promise came from nowhere — and a delivery date the shop cannot hit is a
  complaint the merchant inherits.
- **Hedging is judged by subject.** Unsure about a colour is fine; unsure about a
  refund is not. The check fires on the combination.

### Review pass — problems found and fixed

- **"Safe for pregnancy" was not caught.** The pattern ended a stem with a word
  boundary, so `pregnan\b` could never match `pregnancy` — the next character is
  still a word character. Every stem now consumes its own word. This class of bug is
  invisible without a test per phrase, which is why there is one.
- **"Gets to you tomorrow" was not caught.** The delivery pattern required a
  preposition, so promises phrased without one passed. A promise does not need a
  preposition to commit the merchant.
- **Guardrails could be bypassed by a new send path.** They ran in the shopper loop
  only. Moved into `deliverReply` as well, so private replies to comments, restock
  notices and revivals — none of which exist yet — are covered by construction
  rather than by whoever writes them remembering. Running twice costs nothing; they
  are pure regex.

### Open, for §4.10

- **No guardrail proved impractical to enforce in code.** The two that came closest
  are price checking (needs the ledger, and needs bundle sums to stay usable) and
  unfounded promises (regex over natural language, so it will have false positives).
  Both fail closed: a false positive costs the merchant an approval tap, a false
  negative costs them a customer.

---

## Stage 5 — Payments

**Done when:** a conversation ends in a paid link and one attributed sale row.

### Shipped

- Stripe Connect via Standard OAuth, with a signed `state` so the callback can
  prove the merchant coming back is the one who left.
- `create_payment_link` for real: prices and availability come from our synced
  catalogue, never from the model, and the charge is made on the merchant's own
  connected account.
- Stripe webhook → `payment_links.status` → `attributed_sales`, plus conversation
  outcome and customer lifetime value.
- 8 more tests (125 total), all on the OAuth state signing.

### Decisions

- **Checkout Sessions, not Payment Links — a deliberate deviation from §4.3.** The
  spec's column name implies Stripe's Payment Links API, and the session id is
  stored there. Payment Links need a pre-existing Price object, so quoting one live
  is three round trips inside a five-second budget and slowly fills the merchant's
  Stripe catalogue with throwaway products. Sessions take inline price data: one
  call, exact catalogue price, nothing left behind. They also expire, which suits a
  DM sale — an immortal link is a price quote that outlives the stock behind it.
- **Direct charges on the merchant's account. No platform fee taken.** We are a
  service they hire, not a payment processor. Pricing is invoiced against revenue
  generated (§1.1), which keeps us out of the money flow entirely — a platform
  holding funds is a different business with different obligations. **Worth
  confirming:** if you ever want the fee collected automatically instead of
  invoiced, that is a one-line change here, but it changes what we are.
- **The Stripe API version is pinned.** Letting Stripe pick means a silent API
  change lands in a payment path with no deploy.

### Review pass — problems found and fixed

- **A sale with no conversation would have crashed the webhook.** The lookup passed
  an empty string to a uuid column, which Postgres rejects outright. Such a sale is
  still worth recording — it just cannot be traced to a source.
- **A mixed-currency basket would have failed opaquely at Stripe.** Now refused
  with a reason the agent can act on.
- **Expiry handling was importing modules inside a route handler.** Moved out.

---

## Stage 6 — Capture surfaces

**Done when:** a buying-intent comment becomes a live conversation, and a sold-out
enquiry creates a waitlist entry.

### Shipped

- Comment capture: four gates (not the merchant's own comment, not already
  handled, inside the 7-day reply window, actually a buying signal), then a private
  reply that opens a conversation.
- A two-stage intent classifier — deterministic rules first, a cheap model call
  only for the ambiguous middle.
- Private replies routed through the comment endpoint, with the 7-day comment
  window rather than the 24-hour DM window.
- Story replies handled as their own source, with the agent told it cannot see the
  story it is replying to.
- Waitlist confirmed working end to end from the tool built in stage 3.
- 41 more tests (166 total), all on intent classification.

### Decisions

- **Nothing is written until intent passes.** A post gets 47 comments and nine are
  buying signals (§1.3). Creating a conversation per comment would fill the
  merchant's customer list with people who wrote "obsessed 😍".
- **The ambiguous middle is the only thing worth a model call.** A bare question
  with no buying words gets one; everything the rules settle does not. A 47-comment
  post costs a handful of calls, not 47.
- **The classifier fails quiet.** If the model is unreachable, the answer is
  "noise". An outage must not turn into unsolicited DMs from a merchant's account —
  that is the account-restriction risk §1.7 calls fatal.
- **The comment claim is taken before the intent check.** Two concurrent deliveries
  of the same comment cannot then both decide to reply, and Meta allows exactly one
  private reply per comment, ever.

### Review pass — problems found and fixed

- **Every comment reply would have been queued instead of sent.** The delivery path
  applied the 24-hour DM window to private replies. A commenter has by definition
  never sent a DM, so that window is the wrong clock — a private reply is legal for
  7 days from the comment. This would have silently disabled the single
  highest-value feature.
- **"link?" was not recognised as a buying signal.** Same shape of bug as the two
  in stage 4: an alternative ending in `$` inside a group closed by `\b` can never
  match. One-word asks now have their own pattern.
- **The first draft of the claim logic wrote a placeholder merchant id** that would
  have violated the foreign key. Rewritten to resolve the merchant first.

---

## Stage 7 — Proactive

**Done when:** a restocked item notifies its waitlist, and a 24h-stale conversation
gets a follow-up.

### Shipped

- Restock notification job: waitlisted entries whose product is back, checked
  against the messaging window and the caps before a word is drafted.
- Dead thread revival job: one follow-up per conversation, ever.
- Rate limits and daily caps in code (§1.7), with the reply circuit breaker
  enforced inside the delivery path so no send path can skip it.
- `decideRevival` extracted as a pure function, so the rule that decides whether a
  merchant's account sends an unprompted message is testable without a database.
- 14 more tests (180 total).

### The limits, and why these numbers

| Limit | Value | Reasoning |
|---|---|---|
| Replies per merchant per hour | 120 | A circuit breaker for a loop gone wrong, not a business rule. A boutique with 20+ DMs a day is nowhere near it |
| Proactive sends per merchant per day | 40 | This is where account standing is actually spent |
| Proactive sends per customer per week | 1 | Twice in a week is pestering, not selling |
| Revivals per conversation | 1 | §2.5 says "follow-up", not "follow-ups". A second is nagging |

### Decisions

- **Reactive and proactive are limited differently.** Someone who messaged the shop
  expects an answer, and the volume is set by the shoppers. Someone who did not
  message is where the account-restriction risk lives.
- **Undeliverable notices are never queued.** A restock notice for a shopper whose
  7-day window has closed would sit in the merchant's approval list and fail the
  moment they tapped send. Better to retire the waitlist entry than to offer them a
  button that does not work.
- **Revival is stamped before the send, not after.** A crash mid-turn must not leave
  a conversation eligible for a second nudge on the next sweep.
- **A queued restock notice still marks the entry notified.** The merchant has it
  either way, and re-queuing the same notice every hour would bury their approvals.

### Review pass — problems found and fixed

- **Revival eligibility was spread across the sweep loop**, mixing database
  filtering with the actual rule. Extracted to a pure function — this is the code
  that decides whether a merchant's account messages someone unprompted, and it
  deserved to be readable and tested on its own.
- **Restock did not check the messaging window**, so it would draft and queue
  notices that could never be delivered.
- **`alreadyRevived` was inspecting JSON in the message log.** Replaced with a
  column: the sweep runs four-hourly across every merchant.

### Next

Stage 8 — the dashboard: metrics, escalations queue, customers, settings.
