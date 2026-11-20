import test from "node:test";
import assert from "node:assert/strict";
import { onRequestPost } from "../functions/api/mpesa-callback.js";

function callbackContext({ code = 0, amount, receipt, expected = 55, selfReferral = false } = {}) {
  const calls = [];
  const record = {
    mpesa_tx_id: 1, order_id: 9, order_reference: "BBQ-TEST",
    customer_id: 3, recipient_phone: "254700000001", amount_kes: expected,
    points_earned: 5, points_redeemed: 0,
    applied_referral_code: selfReferral ? "SELF" : null,
    payment_status: "PENDING"
  };
  const db = {
    prepare(sql) {
      const statement = {
        bind(...args) { calls.push({ sql, args }); return statement; },
        async first() {
          if (sql.includes("FROM mpesa_transactions")) return record;
          if (sql.includes("FROM customers WHERE referral_code")) return { id: 3 };
          return null;
        },
        async run() { return { success: true }; }
      };
      return statement;
    },
    async batch(statements) { calls.push({ batchCount: statements.length }); return []; }
  };
  const items = [];
  if (amount !== undefined) items.push({ Name: "Amount", Value: amount });
  if (receipt !== undefined) items.push({ Name: "MpesaReceiptNumber", Value: receipt });
  const payload = { Body: { stkCallback: {
    CheckoutRequestID: "ws_test_1", ResultCode: code,
    CallbackMetadata: { Item: items }
  } } };
  return {
    calls,
    context: {
      env: { MPESA_CALLBACK_SECRET: "secret", DB: db },
      request: new Request("https://example.test/api/mpesa-callback?token=secret", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      })
    }
  };
}

test("missing M-Pesa receipt cannot mark an order paid", async () => {
  const { context, calls } = callbackContext({ amount: 55 });
  const response = await onRequestPost(context);
  assert.equal(response.status, 422);
  assert.equal(calls.some(x => x.sql?.includes("SET payment_status = 'PAID'")), false);
});
test("invalid amount cannot mark an order paid", async () => {
  const { context, calls } = callbackContext({ amount: "not-a-number", receipt: "ABC1234567" });
  const response = await onRequestPost(context);
  assert.equal(response.status, 422);
  assert.equal(calls.some(x => x.sql?.includes("SET payment_status = 'PAID'")), false);
});
test("amount mismatch stays pending and is recorded for reconciliation", async () => {
  const { context, calls } = callbackContext({ amount: 54, receipt: "ABC1234567" });
  const response = await onRequestPost(context);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ResultDesc, "Payment held for reconciliation");
  assert.equal(calls.some(x => x.sql?.includes("SET payment_status = 'FAILED'")), false);
  assert.equal(calls.some(x => x.sql?.includes("SET payment_status = 'PAID'")), false);
});
test("invalid result codes are rejected", async () => {
  const { context } = callbackContext({ code: "not-a-number" });
  const response = await onRequestPost(context);
  assert.equal(response.status, 400);
});
test("self-referral cannot create duplicate referral rewards", async () => {
  const { context, calls } = callbackContext({ amount: 55, receipt: "ABC1234567", selfReferral: true });
  const response = await onRequestPost(context);
  assert.equal(response.status, 200);
  assert.equal(calls.some(x => x.sql?.includes("'REFERRAL_BONUS'")), false);
});
