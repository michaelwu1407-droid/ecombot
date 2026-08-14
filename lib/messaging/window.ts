/**
 * Meta messaging windows — provider-independent, because they are Meta's rules,
 * not the bridge provider's. Enforced in code, never in prompt (§3.3), because
 * the failure mode is a restricted merchant account, and that is their livelihood
 * (§1.7).
 *
 * The rules, as they actually apply to Instagram:
 *
 *   * Standard window — 24 hours from the customer's most recent message. Inside
 *     it, anything may be sent. This covers essentially all shopper-agent replies.
 *
 *   * HUMAN_AGENT tag — extends to 7 days, and is the only tag Instagram supports.
 *     Meta scopes it to responses handled by a human agent. An automated blast
 *     sent under this tag is a policy violation, so we gate it on merchant review
 *     rather than sending it unattended.
 *
 *   * After 7 days there is no route. The conversation is closed, full stop.
 *
 *   * Private replies to comments run on their own clock: 7 days from the comment,
 *     one reply per comment, ever.
 *
 * This constrains §2.5 more tightly than the spec assumed. See the build report:
 * a restock notification fired more than 7 days after the customer last wrote is
 * undeliverable, whatever the product would prefer.
 */

export const STANDARD_WINDOW_MS = 24 * 60 * 60 * 1000;
export const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const COMMENT_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type WindowState =
  /** Inside 24h. Send freely. */
  | { state: 'open'; requiresTag: false }
  /** 24h-7d. Deliverable only under HUMAN_AGENT, which means merchant review first. */
  | { state: 'human_agent_only'; requiresTag: true }
  /** Past 7 days. Nothing can be sent. */
  | { state: 'closed'; requiresTag: false };

/**
 * @param lastInboundAt when the customer last messaged us, or null if they never have
 */
export function messagingWindowState(lastInboundAt: Date | null, now: Date = new Date()): WindowState {
  if (!lastInboundAt) return { state: 'closed', requiresTag: false };

  const elapsed = now.getTime() - lastInboundAt.getTime();
  if (elapsed < STANDARD_WINDOW_MS) return { state: 'open', requiresTag: false };
  if (elapsed < HUMAN_AGENT_WINDOW_MS) return { state: 'human_agent_only', requiresTag: true };
  return { state: 'closed', requiresTag: false };
}

/** True when a message may be sent unattended, with no tag and no merchant review. */
export function isWithinMessagingWindow(lastInboundAt: Date | null, now: Date = new Date()): boolean {
  return messagingWindowState(lastInboundAt, now).state === 'open';
}

/** A comment may be privately replied to once, within 7 days. */
export function canPrivateReplyToComment(commentCreatedAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - commentCreatedAt.getTime() < COMMENT_REPLY_WINDOW_MS;
}
