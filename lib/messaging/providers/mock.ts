import { createHmac } from 'node:crypto';
import type { InboundEvent, Message, MessagingProvider, SendResult } from '../types';
import { parseZernioEvent } from './zernio';

/**
 * In-memory provider for tests and local development.
 *
 * Not a shortcut around the real integration — it is how the end-to-end path
 * (§4.9) stays runnable without live Instagram credentials, and how guardrail
 * and agent tests assert on what would have been sent to a real customer.
 *
 * It accepts the same event shape as the bridge provider so a payload captured
 * from a real webhook can be replayed against it verbatim.
 */

export interface SentMessage {
  kind: 'dm' | 'private_reply';
  accountId: string;
  recipientId: string;
  commentId?: string;
  postId?: string;
  text: string;
  messageId: string;
  sentAt: Date;
}

const MOCK_SECRET = 'mock-webhook-secret';

export class MockMessagingProvider implements MessagingProvider {
  readonly name = 'mock';
  readonly sent: SentMessage[] = [];

  private history = new Map<string, Message[]>();
  private counter = 0;
  private failNextWith: Error | null = null;

  reset(): void {
    this.sent.length = 0;
    this.history.clear();
    this.counter = 0;
    this.failNextWith = null;
  }

  /** Makes the next send throw, so callers can be tested against send failures. */
  failNext(error: Error): void {
    this.failNextWith = error;
  }

  seedHistory(accountId: string, participantId: string, messages: Message[]): void {
    this.history.set(`${accountId}:${participantId}`, messages);
  }

  /** The last thing a customer would have seen. */
  lastSent(): SentMessage | undefined {
    return this.sent[this.sent.length - 1];
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }

  private throwIfArmed(): void {
    if (this.failNextWith) {
      const error = this.failNextWith;
      this.failNextWith = null;
      throw error;
    }
  }

  async sendMessage(accountId: string, recipientId: string, text: string): Promise<SendResult> {
    this.throwIfArmed();
    const messageId = this.nextId('mock_msg');
    this.sent.push({ kind: 'dm', accountId, recipientId, text, messageId, sentAt: new Date() });
    return { messageId, conversationId: `mock_conv_${recipientId}` };
  }

  async sendPrivateReplyToComment(
    accountId: string,
    commentId: string,
    text: string,
    postId?: string
  ): Promise<SendResult> {
    this.throwIfArmed();
    const messageId = this.nextId('mock_priv');
    this.sent.push({
      kind: 'private_reply',
      accountId,
      recipientId: commentId,
      commentId,
      postId,
      text,
      messageId,
      sentAt: new Date(),
    });
    return { messageId };
  }

  async verifyWebhook(req: Request): Promise<boolean> {
    const raw = await req.clone().text();
    const expected = createHmac('sha256', MOCK_SECRET).update(raw, 'utf8').digest('hex');
    return req.headers.get('x-zernio-signature') === expected;
  }

  /** Signs a body the way the mock verifier expects, for tests that post webhooks. */
  static sign(rawBody: string): string {
    return createHmac('sha256', MOCK_SECRET).update(rawBody, 'utf8').digest('hex');
  }

  parseInboundEvent(payload: unknown): InboundEvent | null {
    // Reuses the bridge parser so tests exercise the real parsing logic.
    const { parseZernioEvent } = require('./zernio') as typeof import('./zernio');
    return parseZernioEvent(payload);
  }

  async getConversationHistory(accountId: string, participantId: string, limit: number): Promise<Message[]> {
    return (this.history.get(`${accountId}:${participantId}`) ?? []).slice(-limit);
  }

  async listRecentOutboundMessages(accountId: string, limit: number): Promise<Message[]> {
    const all: Message[] = [];
    for (const [key, messages] of this.history) {
      if (!key.startsWith(`${accountId}:`)) continue;
      all.push(...messages.filter((message) => message.direction === 'outbound'));
    }
    return all.slice(0, limit);
  }
}

/** Shared instance, so a test can assert on what the webhook route sent. */
export const mockProvider = new MockMessagingProvider();
