import { env } from '../../env';
import { verifyHmacSha256Hex } from '../../crypto';
import { MessagingError, type InboundEvent, type Message, type MessagingProvider, type SendResult } from '../types';

/**
 * Bridge provider: Zernio (BUILD_SPEC §3.2).
 *
 * Launching here rather than on Meta direct buys 3-8 weeks. When Meta approval
 * lands, providers/meta.ts implements the same interface and index.ts switches.
 *
 * Verified against the provider docs before writing this file:
 *   * inbound webhooks — `message.received`, `conversation.started`  ✓
 *   * comment events   — `comment.received` as a raw event, not just
 *                        their no-code keyword automation product     ✓
 *   * per-merchant     — a profile per customer, OAuth connect, and
 *                        `account.id` on every inbound payload        ✓
 */

const API_BASE = 'https://zernio.com/api/v1';
const SIGNATURE_HEADER = 'x-zernio-signature';

/** Provider ack budget is 5s; a hung send must not hold the webhook open. */
const REQUEST_TIMEOUT_MS = 8_000;

type ZernioEnvelope<T> = { success?: boolean; data?: T; error?: string; code?: string };

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.messagingApiKey()}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const body = (await response.json().catch(() => ({}))) as ZernioEnvelope<T> & Record<string, unknown>;

  if (!response.ok) {
    // 429 and 5xx are worth retrying; a 400 means the request itself is wrong.
    const retryable = response.status === 429 || response.status >= 500;
    throw new MessagingError(
      typeof body.error === 'string' ? body.error : `Zernio ${path} failed with ${response.status}`,
      typeof body.code === 'string' ? body.code : `HTTP_${response.status}`,
      retryable
    );
  }

  return (body.data ?? body) as T;
}

export const zernioProvider: MessagingProvider = {
  name: 'zernio',

  /**
   * Opens the thread if there isn't one and sends in a single call, which is what
   * we want on every path: a first reply, a revival, and a restock notice all
   * look the same to us.
   */
  async sendMessage(accountId, recipientId, text): Promise<SendResult> {
    const data = await call<{ messageId?: string; conversationId?: string }>('/inbox/conversations', {
      method: 'POST',
      body: JSON.stringify({ accountId, participantId: recipientId, message: text }),
    });

    if (!data.messageId) {
      throw new MessagingError('Zernio accepted the send but returned no messageId', 'NO_MESSAGE_ID');
    }
    return { messageId: data.messageId, conversationId: data.conversationId };
  },

  /**
   * Turns a public comment into a private conversation — the single largest leak
   * in the merchant's day (§2.3). Meta allows exactly one private reply per
   * comment, within 7 days, so a failed send here is not retryable in kind.
   */
  async sendPrivateReplyToComment(accountId, commentId, text, postId): Promise<SendResult> {
    if (!postId) {
      throw new MessagingError(
        'Zernio addresses private replies as /comments/{postId}/{commentId} — postId is required',
        'POST_ID_REQUIRED'
      );
    }

    const data = await call<{ messageId?: string; status?: string }>(
      `/inbox/comments/${encodeURIComponent(postId)}/${encodeURIComponent(commentId)}/private-reply`,
      { method: 'POST', body: JSON.stringify({ accountId, message: text }) }
    );

    if (!data.messageId) {
      throw new MessagingError('Zernio accepted the private reply but returned no messageId', 'NO_MESSAGE_ID');
    }
    return { messageId: data.messageId };
  },

  /**
   * HMAC-SHA256 of the raw body, lowercase hex, in X-Zernio-Signature.
   * Reads the body via clone() so the caller can still read it — signature
   * verification must run against the exact bytes received, not a re-serialisation.
   */
  async verifyWebhook(req: Request): Promise<boolean> {
    const raw = await req.clone().text();
    return verifyHmacSha256Hex(raw, req.headers.get(SIGNATURE_HEADER), env.messagingWebhookSecret());
  },

  parseInboundEvent(payload: unknown): InboundEvent | null {
    return parseZernioEvent(payload);
  },

  async getConversationHistory(accountId, participantId, limit): Promise<Message[]> {
    const conversations = await call<Array<{ id: string; participantId?: string }>>(
      `/inbox/conversations?accountId=${encodeURIComponent(accountId)}&limit=50`,
      { method: 'GET' }
    );

    const match = Array.isArray(conversations)
      ? conversations.find((c) => c.participantId === participantId)
      : undefined;
    if (!match) return [];

    const messages = await call<Array<{ id: string; direction: string; text: string | null; sentAt: string }>>(
      `/inbox/conversations/${encodeURIComponent(match.id)}/messages?limit=${limit}`,
      { method: 'GET' }
    );

    return (Array.isArray(messages) ? messages : []).map((m) => ({
      id: m.id,
      direction: m.direction === 'incoming' ? ('inbound' as const) : ('outbound' as const),
      text: m.text ?? '',
      createdAt: new Date(m.sentAt),
    }));
  },

  /**
   * Walks the merchant's recent threads and collects what they sent.
   *
   * Note from the provider docs: when an Instagram account connects, Meta's
   * existing DM history is replayed into the inbox in the background, keeping its
   * real timestamps — so a sweep run immediately after connecting can look
   * complete while missing years of it. Onboarding runs this once, and the
   * merchant can re-run it later to pick up the rest.
   */
  async listRecentOutboundMessages(accountId, limit): Promise<Message[]> {
    const conversations = await call<Array<{ id: string }>>(
      `/inbox/conversations?accountId=${encodeURIComponent(accountId)}&limit=25`,
      { method: 'GET' }
    );

    const collected: Message[] = [];

    for (const conversation of Array.isArray(conversations) ? conversations : []) {
      if (collected.length >= limit) break;

      const messages = await call<Array<{ id: string; direction: string; text: string | null; sentAt: string }>>(
        `/inbox/conversations/${encodeURIComponent(conversation.id)}/messages?limit=20`,
        { method: 'GET' }
      );

      for (const message of Array.isArray(messages) ? messages : []) {
        if (message.direction === 'incoming' || !message.text) continue;
        collected.push({
          id: message.id,
          direction: 'outbound',
          text: message.text,
          createdAt: new Date(message.sentAt),
        });
        if (collected.length >= limit) break;
      }
    }

    return collected;
  },
};

// ---------------------------------------------------------------------------
// Payload parsing
//
// Hand-written rather than schema-validated: these shapes are small, and the
// alternative is a validation dependency the stack list (§4.1) does not include.
// Anything unrecognised returns null and is acknowledged, never retried forever.
// ---------------------------------------------------------------------------

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseZernioEvent(payload: unknown): InboundEvent | null {
  const root = obj(payload);
  if (!root) return null;

  const eventName = str(root.event);
  const eventId = str(root.id);
  if (!eventName || !eventId) return null;

  const account = obj(root.account);
  const providerAccountId = account ? str(account.accountId) ?? str(account.id) : null;
  if (!providerAccountId) return null;

  // We only act on Instagram. Other platforms may arrive on the same endpoint if
  // a merchant connects one; acknowledge and ignore rather than misroute.
  const platform = account ? str(account.platform) : null;
  if (platform && platform !== 'instagram') return null;

  const timestamp = str(root.timestamp) ? new Date(str(root.timestamp)!) : new Date();

  if (eventName === 'message.received') {
    const message = obj(root.message);
    if (!message) return null;
    if (str(message.direction) === 'outgoing') return null; // our own send, echoed back

    const sender = obj(message.sender);
    const senderId = sender ? str(sender.id) : null;
    const text = str(message.text);
    if (!senderId || !text) return null; // attachment-only messages carry no text to answer

    return {
      providerAccountId,
      senderId,
      senderHandle: sender ? str(sender.username) : null,
      senderName: sender ? str(sender.name) : null,
      text,
      eventId,
      timestamp: str(message.sentAt) ? new Date(str(message.sentAt)!) : timestamp,
      // A story reply is a DM whose payload references the story it answers.
      type: isStoryReply(message) ? 'story_reply' : 'dm',
      providerConversationId: str(message.conversationId) ?? undefined,
    };
  }

  if (eventName === 'comment.received') {
    const comment = obj(root.comment);
    if (!comment) return null;

    const author = obj(comment.author);
    const senderId = author ? str(author.id) : null;
    const text = str(comment.text);
    const commentId = str(comment.id);
    const postId = str(comment.platformPostId);
    if (!senderId || !text || !commentId || !postId) return null;

    return {
      providerAccountId,
      senderId,
      senderHandle: author ? str(author.username) : null,
      senderName: author ? str(author.name) : null,
      text,
      eventId,
      timestamp: str(comment.createdAt) ? new Date(str(comment.createdAt)!) : timestamp,
      type: 'comment',
      commentId,
      postId,
      isReply: comment.isReply === true,
    };
  }

  return null;
}

/**
 * Instagram delivers story replies as DMs. The story reference appears as an
 * attachment or in the payload metadata depending on the reply type; either
 * marker is enough to route it as its own capture surface (§2.3).
 */
function isStoryReply(message: Record<string, unknown>): boolean {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const hasStoryAttachment = attachments.some((a) => {
    const attachment = obj(a);
    if (!attachment) return false;
    const payload = obj(attachment.payload);
    return Boolean(payload && (payload.storyId || payload.story_id || payload.reply_to_story));
  });
  if (hasStoryAttachment) return true;

  const payload = obj(message.payload);
  return Boolean(payload && (payload.storyId || payload.story_id));
}
