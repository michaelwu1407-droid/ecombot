import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseZernioEvent } from '../lib/messaging/providers/zernio';
import {
  messagingWindowState,
  isWithinMessagingWindow,
  canPrivateReplyToComment,
  STANDARD_WINDOW_MS,
  HUMAN_AGENT_WINDOW_MS,
} from '../lib/messaging/window';

const account = { id: 'acct_1', accountId: 'acct_1', platform: 'instagram', username: 'boutique' };

function dmEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt_1',
    event: 'message.received',
    message: {
      id: 'msg_1',
      conversationId: 'conv_1',
      platform: 'instagram',
      platformMessageId: 'ig_1',
      direction: 'incoming',
      text: 'do you have the linen dress in a 10?',
      attachments: [],
      sender: { id: 'igsid_1', name: 'Jane', username: 'jane_doe' },
      sentAt: '2026-08-14T10:00:00.000Z',
      ...overrides,
    },
    account,
    timestamp: '2026-08-14T10:00:01.000Z',
  };
}

function commentEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt_2',
    event: 'comment.received',
    comment: {
      id: 'comment_1',
      postId: null,
      platformPostId: 'media_1',
      platform: 'instagram',
      text: 'price?',
      author: { id: 'igsid_2', username: 'shopper', name: 'Sam' },
      createdAt: '2026-08-14T11:00:00.000Z',
      isReply: false,
      parentCommentId: null,
      ...overrides,
    },
    post: { id: null, platformPostId: 'media_1', content: 'new arrivals', imageUrl: null, permalink: null },
    account,
    timestamp: '2026-08-14T11:00:01.000Z',
  };
}

describe('parseZernioEvent', () => {
  test('parses an inbound DM', () => {
    const event = parseZernioEvent(dmEvent());
    assert.ok(event);
    assert.equal(event.type, 'dm');
    assert.equal(event.providerAccountId, 'acct_1');
    assert.equal(event.senderId, 'igsid_1');
    assert.equal(event.senderHandle, 'jane_doe');
    assert.equal(event.text, 'do you have the linen dress in a 10?');
    assert.equal(event.providerConversationId, 'conv_1');
    assert.equal(event.timestamp.toISOString(), '2026-08-14T10:00:00.000Z');
  });

  test('parses a comment with the postId needed to reply privately', () => {
    const event = parseZernioEvent(commentEvent());
    assert.ok(event);
    assert.equal(event.type, 'comment');
    assert.equal(event.commentId, 'comment_1');
    assert.equal(event.postId, 'media_1');
    assert.equal(event.isReply, false);
    assert.equal(event.senderId, 'igsid_2');
  });

  test('routes a story reply to its own capture surface', () => {
    const event = parseZernioEvent(
      dmEvent({ attachments: [{ type: 'image', url: 'https://cdn', payload: { storyId: 'story_9' } }] })
    );
    assert.ok(event);
    assert.equal(event.type, 'story_reply');
  });

  test('ignores our own outbound message echoed back', () => {
    assert.equal(parseZernioEvent(dmEvent({ direction: 'outgoing' })), null);
  });

  test('ignores an attachment-only message with no text to answer', () => {
    assert.equal(parseZernioEvent(dmEvent({ text: null })), null);
  });

  test('ignores non-Instagram platforms sharing the endpoint', () => {
    const payload = dmEvent();
    payload.account = { ...account, platform: 'telegram' };
    assert.equal(parseZernioEvent(payload), null);
  });

  test('ignores events we do not handle', () => {
    assert.equal(parseZernioEvent({ id: 'e', event: 'post.published', account }), null);
    assert.equal(parseZernioEvent({ id: 'e', event: 'message.delivered', account }), null);
  });

  test('rejects malformed payloads rather than throwing', () => {
    assert.equal(parseZernioEvent(null), null);
    assert.equal(parseZernioEvent('nope'), null);
    assert.equal(parseZernioEvent({}), null);
    assert.equal(parseZernioEvent({ id: 'e', event: 'message.received' }), null);
    // account present but no id — cannot route to a merchant
    assert.equal(parseZernioEvent({ id: 'e', event: 'message.received', account: {} }), null);
  });

  test('rejects a comment with no postId, which could not be replied to', () => {
    assert.equal(parseZernioEvent(commentEvent({ platformPostId: null })), null);
  });
});

describe('messaging windows', () => {
  const now = new Date('2026-08-14T12:00:00.000Z');

  test('inside 24 hours the agent may send freely', () => {
    const lastInbound = new Date(now.getTime() - 60_000);
    assert.deepEqual(messagingWindowState(lastInbound, now), { state: 'open', requiresTag: false });
    assert.equal(isWithinMessagingWindow(lastInbound, now), true);
  });

  test('between 24 hours and 7 days only HUMAN_AGENT can deliver', () => {
    const lastInbound = new Date(now.getTime() - STANDARD_WINDOW_MS - 60_000);
    assert.deepEqual(messagingWindowState(lastInbound, now), {
      state: 'human_agent_only',
      requiresTag: true,
    });
    // Not sendable unattended — this is what stops an automated restock notice
    // going out under a tag Meta scopes to human agents.
    assert.equal(isWithinMessagingWindow(lastInbound, now), false);
  });

  test('past 7 days there is no route at all', () => {
    const lastInbound = new Date(now.getTime() - HUMAN_AGENT_WINDOW_MS - 60_000);
    assert.deepEqual(messagingWindowState(lastInbound, now), { state: 'closed', requiresTag: false });
  });

  test('a customer who never messaged cannot be messaged', () => {
    assert.deepEqual(messagingWindowState(null, now), { state: 'closed', requiresTag: false });
  });

  test('the 24 hour boundary is exclusive', () => {
    const exactly24h = new Date(now.getTime() - STANDARD_WINDOW_MS);
    assert.equal(messagingWindowState(exactly24h, now).state, 'human_agent_only');
    const justInside = new Date(now.getTime() - STANDARD_WINDOW_MS + 1);
    assert.equal(messagingWindowState(justInside, now).state, 'open');
  });

  test('comments can be privately replied to for 7 days', () => {
    assert.equal(canPrivateReplyToComment(new Date(now.getTime() - 6 * 86_400_000), now), true);
    assert.equal(canPrivateReplyToComment(new Date(now.getTime() - 8 * 86_400_000), now), false);
  });
});
