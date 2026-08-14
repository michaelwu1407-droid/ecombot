import { MessagingError, type InboundEvent, type Message, type MessagingProvider, type SendResult } from '../types';

/**
 * Meta direct — stub (BUILD_SPEC §3.2, §4.2).
 *
 * Not wired up. Meta app review for Instagram messaging takes 3-8 weeks and
 * requires business verification first; we launch on the bridge provider and
 * swap here when approval lands. This file exists so that swap stays a one-file
 * change and so nobody re-derives the interface under deadline pressure.
 *
 * Notes for whoever implements it, gathered while building the bridge adapter:
 *
 *   * Sending: POST /{ig-user-id}/messages with { recipient: { id }, message: { text } }.
 *   * Private reply: the same endpoint with { recipient: { comment_id } }. Meta keys
 *     off the comment alone, so the `postId` argument is unused here — it exists
 *     only because the bridge provider addresses the endpoint differently.
 *   * Webhooks: Meta signs with X-Hub-Signature-256 as `sha256=<hex>` over the raw
 *     body, and requires a GET challenge handshake at subscription time that the
 *     bridge provider does not.
 *   * Inbound comments arrive under entry[].changes[] with field `comments`, not as
 *     a flat event — parseInboundEvent must walk that structure.
 *   * The 24-hour messaging window and the HUMAN_AGENT tag apply identically; that
 *     logic lives in lib/messaging/window.ts and is provider-independent by design.
 */

function notImplemented(operation: string): never {
  throw new MessagingError(
    `Meta direct provider is not implemented (${operation}). Set MESSAGING_PROVIDER=zernio until Meta app review is approved.`,
    'PROVIDER_NOT_IMPLEMENTED'
  );
}

export const metaProvider: MessagingProvider = {
  name: 'meta',

  async sendMessage(_accountId: string, _recipientId: string, _text: string): Promise<SendResult> {
    notImplemented('sendMessage');
  },

  async sendPrivateReplyToComment(
    _accountId: string,
    _commentId: string,
    _text: string,
    _postId?: string
  ): Promise<SendResult> {
    notImplemented('sendPrivateReplyToComment');
  },

  async verifyWebhook(_req: Request): Promise<boolean> {
    // Fails closed. An unimplemented verifier must never wave a payload through.
    return false;
  },

  parseInboundEvent(_payload: unknown): InboundEvent | null {
    return null;
  },

  async getConversationHistory(_accountId: string, _participantId: string, _limit: number): Promise<Message[]> {
    notImplemented('getConversationHistory');
  },
};
