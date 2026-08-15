import { messagingWindowState } from '../messaging';

/**
 * Whether a quiet conversation is worth a follow-up (BUILD_SPEC §2.5).
 *
 * Pure, so the rule that decides whether a merchant's account sends an unprompted
 * message is testable without a database. Every "no" here is a message that does
 * not go out, and unprompted messages are what spend account standing (§1.7).
 */

/** Stalled long enough to be worth a nudge, rather than an interruption. */
export const MIN_STALL_MS = 24 * 60 * 60 * 1000;
/** Past this the messaging window has closed and there is no route at all. */
export const MAX_STALL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RevivalCandidate {
  lastMessageAt: Date | null;
  lastInboundAt: Date | null;
  outcome: string | null;
  revivalSentAt: Date | null;
  status: string;
}

export type RevivalDecision =
  | { eligible: true; requiresApproval: boolean }
  | { eligible: false; reason: string; retire: boolean };

export function decideRevival(candidate: RevivalCandidate, now: Date = new Date()): RevivalDecision {
  if (candidate.outcome) {
    return { eligible: false, reason: 'conversation already ended', retire: true };
  }

  if (candidate.revivalSentAt) {
    // One attempt, ever. A second is nagging, and nagging from a merchant's own
    // account is what gets it restricted.
    return { eligible: false, reason: 'already revived', retire: false };
  }

  if (candidate.status === 'escalated') {
    return { eligible: false, reason: 'the merchant is handling this one', retire: false };
  }

  if (candidate.status === 'closed') {
    return { eligible: false, reason: 'conversation closed', retire: true };
  }

  if (!candidate.lastMessageAt) {
    return { eligible: false, reason: 'no activity to follow up on', retire: false };
  }

  const quietFor = now.getTime() - candidate.lastMessageAt.getTime();
  if (quietFor < MIN_STALL_MS) {
    return { eligible: false, reason: 'not quiet long enough yet', retire: false };
  }

  const window = messagingWindowState(candidate.lastInboundAt, now);
  if (window.state === 'closed') {
    // No tag reaches them any more. Retired so the sweep stops reconsidering it
    // every four hours forever.
    return { eligible: false, reason: 'messaging window closed', retire: true };
  }

  // Inside 24 hours it can go straight out; beyond that Meta only delivers under a
  // tag scoped to human agents, so the merchant approves it first.
  return { eligible: true, requiresApproval: window.state === 'human_agent_only' };
}
