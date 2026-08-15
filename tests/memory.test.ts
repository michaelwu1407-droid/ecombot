import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseExtraction } from '../lib/agent/memory';

describe('memory extraction parsing', () => {
  test('parses the expected shape', () => {
    const result = parseExtraction('{"size":"10","preferences":{"colours":["navy"]},"budget_range":"under $150","notes":"prefers relaxed fits"}');
    assert.deepEqual(result, {
      size: '10',
      preferences: { colours: ['navy'] },
      budget_range: 'under $150',
      notes: 'prefers relaxed fits',
    });
  });

  test('unwraps a fenced code block', () => {
    const result = parseExtraction('```json\n{"size":"12","preferences":{},"budget_range":null,"notes":null}\n```');
    assert.equal(result?.size, '12');
  });

  test('finds the object inside surrounding prose', () => {
    const result = parseExtraction('Here is what I found:\n{"size":"8","preferences":{},"budget_range":null,"notes":null}\nHope that helps.');
    assert.equal(result?.size, '8');
  });

  test('treats the string "null" as null', () => {
    // Models write this surprisingly often, and storing it would put the literal
    // word "null" on the customer's profile.
    const result = parseExtraction('{"size":"null","budget_range":"unknown","preferences":{},"notes":""}');
    assert.equal(result?.size, null);
    assert.equal(result?.budget_range, null);
    assert.equal(result?.notes, null);
  });

  test('returns null for anything unparseable', () => {
    assert.equal(parseExtraction('I could not find anything.'), null);
    assert.equal(parseExtraction(''), null);
    assert.equal(parseExtraction('{"size":'), null);
    assert.equal(parseExtraction('["not", "an", "object"]'), null);
  });

  test('drops preference values that are not usable', () => {
    const result = parseExtraction('{"preferences":{"a":null,"b":42,"c":"","d":"navy","e":{"nested":1}}}');
    assert.deepEqual(result?.preferences, { d: 'navy' });
  });

  test('keeps string arrays and drops non-string entries', () => {
    const result = parseExtraction('{"preferences":{"colours":["navy",null,42,"cream"]}}');
    assert.deepEqual(result?.preferences, { colours: ['navy', 'cream'] });
  });

  test('caps field length, since this originates in a shopper message', () => {
    const long = 'x'.repeat(500);
    const result = parseExtraction(JSON.stringify({ size: long, preferences: {}, notes: long }));
    assert.equal(result?.size?.length, 120);
    assert.equal(result?.notes?.length, 120);
  });

  test('caps how many preference keys a single message can write', () => {
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 'v']));
    const result = parseExtraction(JSON.stringify({ preferences: many }));
    assert.equal(Object.keys(result?.preferences ?? {}).length, 10);
  });

  test('caps array length inside a preference', () => {
    const many = Array.from({ length: 40 }, (_, i) => `colour${i}`);
    const result = parseExtraction(JSON.stringify({ preferences: { colours: many } }));
    assert.equal((result?.preferences.colours as string[]).length, 10);
  });

  test('missing fields come back as null, not undefined', () => {
    const result = parseExtraction('{}');
    assert.deepEqual(result, { size: null, preferences: {}, budget_range: null, notes: null });
  });
});
