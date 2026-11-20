import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { onRequestPost } from '../functions/api/mpesa-callback.js';
import { onRequestGet } from '../functions/api/order-history.js';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  db.exec(`
    INSERT INTO customers (id, phone_number, loyalty_points, referral_code)
    VALUES (1, '254700000001', 20, 'CUSTOMER'), (2, '254700000002', 0, 'REFERRER');
    INSERT INTO orders (id, order_reference, customer_id, payer_phone, recipient_phone,
                        product_id, amount_kes, cost_kes, points_earned, points_redeemed, applied_referral_code)
    VALUES (1, 'TEST', 1, '254700000001', '254700000001', 1, 55, 42, 10, 5, 'REFERRER');
    INSERT INTO mpesa_transactions (order_id, merchant_request_id, checkout_request_id, phone_number, amount)
    VALUES (1, 'merchant-test', 'checkout-test', '254700000001', 55);
  `);
  const DB = {
    prepare(sql) {
      return {
        bind(...values) {
          const statement = db.prepare(sql);
          return { first: async () => statement.get(...values), run: () => statement.run(...values) };
        }
      };
    },
    async batch(statements) {
      db.exec('BEGIN');
      try {
        for (const statement of statements) statement.run();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  };
  return { db, DB };
}

function callback(env, { token = 'test-secret', amount = 55 } = {}) {
  const request = new Request(`https://example.test/api/mpesa-callback?token=${token}`, {
    method: 'POST',
    body: JSON.stringify({ Body: { stkCallback: {
      CheckoutRequestID: 'checkout-test',
      ResultCode: 0,
      CallbackMetadata: { Item: [
        { Name: 'MpesaReceiptNumber', Value: 'TESTRECEIPT' },
        { Name: 'Amount', Value: amount }
      ] }
    } } })
  });
  return onRequestPost({ env, request });
}

test('order history requires verified access', async () => {
  const response = onRequestGet();
  assert.equal(response.status, 403);
  assert.equal((await response.json()).success, false);
});

test('callback requires configured credentials and matching payment amount', async () => {
  assert.equal((await callback({})).status, 503);
  const { db, DB } = fixture();
  const env = { DB, MPESA_CALLBACK_SECRET: 'test-secret' };
  assert.equal((await callback(env, { token: 'wrong' })).status, 401);
  assert.equal((await callback(env, { amount: 54 })).status, 422);
  assert.equal(db.prepare('SELECT payment_status FROM orders').get().payment_status, 'PENDING');
});

test('concurrent callbacks record a single payment and a hold blocks the fulfillment claim', async () => {
  const { db, DB } = fixture();
  const env = { DB, MPESA_CALLBACK_SECRET: 'test-secret' };
  const claim = db.prepare("UPDATE orders SET fulfillment_status = 'PROCESSING' WHERE id = 1");
  assert.throws(() => claim.run(), /cannot be claimed/);
  db.exec("INSERT INTO sim_swap_holds (phone_number) VALUES ('254700000001')");
  const responses = await Promise.all([callback(env), callback(env)]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.equal(db.prepare('SELECT payment_status FROM orders').get().payment_status, 'PAID');
  assert.equal(db.prepare('SELECT mpesa_receipt_number FROM mpesa_transactions').get().mpesa_receipt_number, 'TESTRECEIPT');
  assert.equal(db.prepare('SELECT COUNT(*) AS points FROM loyalty_ledger').get().points, 4);
  assert.deepEqual(db.prepare('SELECT loyalty_points FROM customers ORDER BY id').all().map(row => row.loyalty_points), [40, 25]);
  assert.throws(() => claim.run(), /cannot be claimed/);
  assert.equal(db.prepare('SELECT fulfillment_status FROM orders').get().fulfillment_status, 'QUEUED');
  db.exec('DELETE FROM sim_swap_holds');
  assert.equal(claim.run().changes, 1);
});
