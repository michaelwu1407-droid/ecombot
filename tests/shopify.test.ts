import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { toCents } from '../lib/shopify/client';
import { normaliseShopDomain } from '../lib/connections';

describe('money conversion', () => {
  test('converts Shopify decimal strings to integer cents', () => {
    assert.equal(toCents('45.00'), 4500);
    assert.equal(toCents('45'), 4500);
    assert.equal(toCents('45.5'), 4550);
    assert.equal(toCents('0.99'), 99);
    assert.equal(toCents('1299.95'), 129995);
  });

  test('rounds rather than truncating', () => {
    // 19.99 * 100 is 1998.9999... in binary floating point. Truncating would
    // quote a customer a cent less than the merchant charges.
    assert.equal(toCents('19.99'), 1999);
    assert.equal(toCents('8.115'), 812);
  });
});

describe('shop domain normalisation', () => {
  test('accepts a bare store name', () => {
    assert.equal(normaliseShopDomain('boutique'), 'boutique.myshopify.com');
  });

  test('accepts a full domain', () => {
    assert.equal(normaliseShopDomain('boutique.myshopify.com'), 'boutique.myshopify.com');
  });

  test('strips a pasted admin URL', () => {
    assert.equal(
      normaliseShopDomain('https://boutique.myshopify.com/admin/products'),
      'boutique.myshopify.com'
    );
  });

  test('normalises case and whitespace', () => {
    assert.equal(normaliseShopDomain('  Boutique.MyShopify.com  '), 'boutique.myshopify.com');
  });

  test('rejects a non-Shopify domain', () => {
    assert.throws(() => normaliseShopDomain('boutique.com'), /not a Shopify store address/);
    assert.throws(() => normaliseShopDomain('evil.com/boutique.myshopify.com'), /not a Shopify/);
  });

  test('rejects empty input', () => {
    assert.throws(() => normaliseShopDomain('   '), /Enter your Shopify store address/);
  });
});
