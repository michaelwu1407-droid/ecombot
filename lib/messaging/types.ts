/**
 * The messaging contract (BUILD_SPEC §4.2).
 *
 * This file and its siblings under lib/messaging/ are the only place in the
 * codebase that may know which provider we are on. Migrating from the bridge
 * provider to Meta direct must be a one-file change, and that only stays true
 * if nothing outside this directory imports a provider SDK or provider type.
 *
 * Two additions to the spec's interface, both forced by the wire protocol:
 *
 *   * `sendPrivateReplyToComment` takes an optional `postId`. Meta's own private
 *     reply API keys off the comment alone, but the bridge provider addresses the
 *     endpoint as /comments/{postId}/{commentId}/private-reply. The parameter is
 *     optional so the spec's three-argument call still compiles; the bridge
 *     adapter rejects a call that omits it, and InboundEvent always carries it.
 *
 *   * `InboundEvent` gains `postId`, `providerConversationId` and `isReply`.
 *     Without postId a comment cannot be answered; without the conversation id a
 *     reply cannot be threaded; isReply distinguishes a top-level buying signal
 *     from a reply buried under someone else's thread.
 */

export interface InboundEvent {
  /** Which merchant account received it — maps to connections.provider_account_id. */
  providerAccountId: string;
  /** The shopper's stable platform id (IGSID on Instagram). */
  senderId: string;
  senderHandle: string | null;
  senderName: string | null;
  text: string;
  /** Provider event id. The dedupe key — delivery is at-least-once. */
  eventId: string;
  timestamp: Date;
  type: 'dm' | 'comment' | 'story_reply';
  /** Present when type === 'comment'. */
  commentId?: string;
  /** Present when type === 'comment'. Required to send a private reply. */
  postId?: string;
  /** Present when type === 'comment'. A reply under another comment, not a top-level one. */
  isReply?: boolean;
  /** Present for DMs and story replies; lets a reply thread into the existing conversation. */
  providerConversationId?: string;
}

export interface Message {
  id: string;
  direction: 'inbound' | 'outbound';
  text: string;
  createdAt: Date;
}

export interface SendResult {
  messageId: string;
  /** Set when the send opened a new thread, so we can persist it for next time. */
  conversationId?: string;
}

export interface MessagingProvider {
  readonly name: string;

  sendMessage(accountId: string, recipientId: string, text: string): Promise<SendResult>;

  sendPrivateReplyToComment(
    accountId: string,
    commentId: string,
    text: string,
    postId?: string
  ): Promise<SendResult>;

  verifyWebhook(req: Request): Promise<boolean>;

  parseInboundEvent(payload: unknown): InboundEvent | null;

  getConversationHistory(accountId: string, participantId: string, limit: number): Promise<Message[]>;
}

/**
 * Thrown when the provider rejects a send for a reason the caller can act on,
 * as opposed to a transport failure worth retrying.
 */
export class MessagingError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code: string, retryable = false) {
    super(message);
    this.name = 'MessagingError';
    this.code = code;
    this.retryable = retryable;
  }
}
