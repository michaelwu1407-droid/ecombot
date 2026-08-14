import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { complete, LLMError } from '../lib/agent/llm';

const realFetch = globalThis.fetch;

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (url: unknown, init: unknown) =>
    handler(String(url), init as RequestInit)) as typeof fetch;
}

function modelResponse(message: Record<string, unknown>) {
  return new Response(JSON.stringify({ choices: [{ message }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.OPENROUTER_MODEL = 'anthropic/claude-sonnet-4';
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('model client', () => {
  test('returns the assistant text', async () => {
    stubFetch(() => modelResponse({ content: '  Yes, we have it in a 10.  ' }));
    const result = await complete({ messages: [{ role: 'user', content: 'hi' }] });

    assert.equal(result.text, 'Yes, we have it in a 10.');
    assert.deepEqual(result.toolCalls, []);
  });

  test('parses tool calls', async () => {
    stubFetch(() =>
      modelResponse({
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            function: { name: 'search_products', arguments: '{"query":"linen dress","size":"10"}' },
          },
        ],
      })
    );

    const result = await complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(result.text, null);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'search_products');
    assert.deepEqual(result.toolCalls[0].arguments, { query: 'linen dress', size: '10' });
  });

  test('survives malformed tool arguments', async () => {
    // Arguments are model-generated JSON strings and do go wrong. An empty object
    // lets the tool's own validation reject it with something recoverable, rather
    // than the whole turn dying and the shopper getting silence.
    stubFetch(() =>
      modelResponse({
        tool_calls: [{ id: 'call_1', function: { name: 'check_stock', arguments: '{"variantId":' } }],
      })
    );

    const result = await complete({ messages: [] });
    assert.deepEqual(result.toolCalls[0].arguments, {});
  });

  test('ignores non-object tool arguments', async () => {
    stubFetch(() =>
      modelResponse({
        tool_calls: [{ id: 'c', function: { name: 'check_stock', arguments: '["nope"]' } }],
      })
    );
    assert.deepEqual((await complete({ messages: [] })).toolCalls[0].arguments, {});
  });

  test('sends tool definitions in the shape the API expects', async () => {
    let sent: Record<string, unknown> = {};
    stubFetch((_url, init) => {
      sent = JSON.parse(String(init.body));
      return modelResponse({ content: 'ok' });
    });

    await complete({
      messages: [],
      tools: [
        {
          name: 'check_stock',
          description: 'Check stock',
          parameters: {
            type: 'object',
            properties: { variantId: { type: 'string' } },
            required: ['variantId'],
            additionalProperties: false,
          },
        },
      ],
    });

    assert.deepEqual(sent.tools, [
      {
        type: 'function',
        function: {
          name: 'check_stock',
          description: 'Check stock',
          parameters: {
            type: 'object',
            properties: { variantId: { type: 'string' } },
            required: ['variantId'],
            additionalProperties: false,
          },
        },
      },
    ]);
  });

  test('marks rate limits and server errors retryable, and client errors not', async () => {
    stubFetch(() => new Response('slow down', { status: 429 }));
    await assert.rejects(complete({ messages: [] }), (error: LLMError) => error.retryable === true);

    stubFetch(() => new Response('bad request', { status: 400 }));
    await assert.rejects(complete({ messages: [] }), (error: LLMError) => error.retryable === false);
  });

  test('surfaces an error object in a 200 response', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: { message: 'no credits' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    await assert.rejects(complete({ messages: [] }), /no credits/);
  });
});

describe('model pinning', () => {
  test("refuses 'auto', which would give inconsistent tone and tool reliability", async () => {
    process.env.OPENROUTER_MODEL = 'auto';
    await assert.rejects(complete({ messages: [] }), /pinned model, never 'auto'/);

    process.env.OPENROUTER_MODEL = 'openrouter/auto';
    await assert.rejects(complete({ messages: [] }), /pinned model, never 'auto'/);
  });

  test('uses the pinned model', async () => {
    let sent: Record<string, unknown> = {};
    stubFetch((_url, init) => {
      sent = JSON.parse(String(init.body));
      return modelResponse({ content: 'ok' });
    });

    await complete({ messages: [] });
    assert.equal(sent.model, 'anthropic/claude-sonnet-4');
  });
});
