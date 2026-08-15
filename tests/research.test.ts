import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { research, isResearchConfigured } from '../lib/research';

const realFetch = globalThis.fetch;

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (url: unknown, init: unknown) =>
    handler(String(url), init as RequestInit)) as typeof fetch;
}

beforeEach(() => {
  process.env.HERMES_API_URL = 'https://hermes.example.com/v1';
  process.env.HERMES_API_KEY = 'test-key';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.HERMES_API_URL;
  delete process.env.HERMES_API_KEY;
});

function answer(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('research delegation', () => {
  test('returns the answer', async () => {
    stubFetch(() => answer('Competitors are charging $60-80 for comparable linen.'));
    const result = await research('what do competitors charge for linen dresses?');

    assert.equal(result.ok, true);
    assert.match(result.answer, /\$60-80/);
  });

  test('posts to the OpenAI-compatible path with the key', async () => {
    let seenUrl = '';
    let seenAuth: string | null = null;
    stubFetch((url, init) => {
      seenUrl = url;
      seenAuth = new Headers(init.headers).get('authorization');
      return answer('ok');
    });

    await research('anything');
    assert.equal(seenUrl, 'https://hermes.example.com/v1/chat/completions');
    assert.equal(seenAuth, 'Bearer test-key');
  });

  test('tolerates a trailing slash on the base URL', async () => {
    process.env.HERMES_API_URL = 'https://hermes.example.com/v1/';
    let seenUrl = '';
    stubFetch((url) => {
      seenUrl = url;
      return answer('ok');
    });

    await research('anything');
    assert.equal(seenUrl, 'https://hermes.example.com/v1/chat/completions');
  });

  test('degrades on its own when the service is down', async () => {
    // This one tool failing must not take anything else with it.
    stubFetch(() => new Response('bad gateway', { status: 502 }));
    const result = await research('anything');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'unreachable');
    assert.match(result.answer, /couldn't get an answer/i);
    assert.match(result.answer, /Everything else still works/i);
  });

  test('degrades when the connection fails outright', async () => {
    stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    const result = await research('anything');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'unreachable');
  });

  test('degrades on an empty answer rather than returning nothing', async () => {
    stubFetch(() => answer('   '));
    const result = await research('anything');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'bad_response');
  });

  test('says so plainly when it is not configured', async () => {
    delete process.env.HERMES_API_URL;
    const result = await research('anything');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'not_configured');
    assert.equal(isResearchConfigured(), false);
  });

  test('rejects an empty question without calling out', async () => {
    let called = false;
    stubFetch(() => {
      called = true;
      return answer('ok');
    });

    const result = await research('   ');
    assert.equal(result.ok, false);
    assert.equal(called, false);
  });

  test('caps the answer length', async () => {
    stubFetch(() => answer('x'.repeat(10_000)));
    const result = await research('anything');
    assert.equal(result.answer.length, 4_000);
  });
});
