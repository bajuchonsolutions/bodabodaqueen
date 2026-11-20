export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // Never accept callbacks when the shared secret is missing.
    // This token is an access gate, not independent proof of settlement.
    if (!env.MPESA_CALLBACK_SECRET || typeof env.MPESA_CALLBACK_SECRET !== "string") {
      console.error("M-Pesa callback authentication is not configured");
      return jsonResponse({ ResultCode: 1, ResultDesc: "Callback unavailable" }, 503);
    }
    const url = new URL(request.url);
    const providedToken = url.searchParams.get("token");
    if (!providedToken || !constantTimeEqual(providedToken, env.MPESA_CALLBACK_SECRET)) {
      return jsonResponse({ ResultCode: 1, ResultDesc: "Unauthorized callback token" }, 401);
    }

    const payload = await request.json();
    const stkCallback = payload?.Body?.stkCallback;

    if (!stkCallback || !stkCallback.CheckoutRequestID) {
      return jsonResponse({ ResultCode: 0, ResultDesc: "Ignored malformed payload" });
    }

    const checkoutRequestId = stkCallback.CheckoutRequestID;
    const resultCode = Number(stkCallback.ResultCode);
    const resultDesc = stkCallback.ResultDesc || "";

    const txRecord = await env.DB.prepare(
      `SELECT
         mt.id AS mpesa_tx_id,
         mt.order_id,
         o.order_reference,
         o.customer_id,
         o.recipient_phone,
         o.amount_kes,
         o.points_earned,
         o.points_redeemed,
         o.applied_referral_code,
         o.payment_status,
         p.name AS product_name
       FROM mpesa_transactions mt
       JOIN orders o ON o.id = mt.order_id
       JOIN products p ON p.id = o.product_id
       WHERE mt.checkout_request_id = ?1`
    )
      .bind(checkoutRequestId)
      .first();

    if (!txRecord) {
      return jsonResponse({ ResultCode: 0, ResultDesc: "Transaction not tracked" });
    }

    if (txRecord.payment_status === "PAID" || txRecord.payment_status === "FAILED") {
      return jsonResponse({ ResultCode: 0, ResultDesc: "Already processed" });
    }

    if (resultCode === 0) {
      const items = stkCallback.CallbackMetadata?.Item || [];
      const getMeta = (name) => items.find((i) => i.Name === name)?.Value ?? null;

      const receiptNumber = getMeta("MpesaReceiptNumber");
      const paidAmount = Number(getMeta("Amount") ?? 0);
      const expectedAmount = Number(txRecord.amount_kes || 0);
      const txDate = getMeta("TransactionDate") ? String(getMeta("TransactionDate")) : null;

      if (paidAmount + 0.01 < expectedAmount) {
        const mismatchReason = `Amount mismatch: paid KES ${paidAmount}, expected KES ${expectedAmount}`;
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE mpesa_transactions
             SET mpesa_receipt_number = ?1, transaction_date = ?2, result_code = 0,
                 result_desc = ?3, raw_callback_json = ?4, updated_at = datetime('now')
             WHERE id = ?5`
          ).bind(receiptNumber, txDate, mismatchReason, JSON.stringify(payload), txRecord.mpesa_tx_id),

          env.DB.prepare(
            `UPDATE orders
             SET payment_status = 'FAILED', fulfillment_status = 'FAILED',
                 failure_reason = ?1, updated_at = datetime('now')
             WHERE id = ?2`
          ).bind(mismatchReason, txRecord.order_id)
        ]);

        return jsonResponse({ ResultCode: 0, ResultDesc: "Logged amount mismatch" });
      }

      const statements = [
        env.DB.prepare(
          `UPDATE mpesa_transactions
           SET mpesa_receipt_number = ?1, transaction_date = ?2, result_code = 0,
               result_desc = ?3, raw_callback_json = ?4, updated_at = datetime('now')
           WHERE id = ?5`
        ).bind(receiptNumber, txDate, resultDesc, JSON.stringify(payload), txRecord.mpesa_tx_id),

        env.DB.prepare(
          `UPDATE orders
           SET payment_status = 'PAID', fulfillment_status = 'QUEUED', updated_at = datetime('now')
           WHERE id = ?1 AND payment_status = 'PENDING'`
        ).bind(txRecord.order_id)
      ];

      if (txRecord.customer_id) {
        // Loyalty balances are updated only by the unique ledger-entry trigger.
        // Replayed callbacks cannot award the same event twice.
        statements.push(
          env.DB.prepare(
            `INSERT OR IGNORE INTO loyalty_ledger (customer_id, order_id, entry_type, points_delta, description)
             SELECT ?1, ?2, 'EARN_PURCHASE', ?3, ?4
             WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?2 AND payment_status = 'PAID')`
          ).bind(
            txRecord.customer_id,
            txRecord.order_id,
            Number(txRecord.points_earned || 0),
            `Earned on bundle order ${txRecord.order_reference}`
          )
        );

        if (Number(txRecord.points_redeemed || 0) > 0) {
          statements.push(
            env.DB.prepare(
              `INSERT OR IGNORE INTO loyalty_ledger (customer_id, order_id, entry_type, points_delta, description)
               SELECT ?1, ?2, 'REDEEM_DISCOUNT', ?3, ?4
               WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?2 AND payment_status = 'PAID')`
            ).bind(
              txRecord.customer_id,
              txRecord.order_id,
              -Number(txRecord.points_redeemed),
              `Redeemed KES 10 discount on ${txRecord.order_reference}`
            )
          );
        }

        if (txRecord.applied_referral_code) {
          const referrer = await env.DB.prepare("SELECT id FROM customers WHERE referral_code = ?1")
            .bind(txRecord.applied_referral_code)
            .first();

          if (referrer) {
            statements.push(
              env.DB.prepare(
                `INSERT OR IGNORE INTO loyalty_ledger (customer_id, order_id, entry_type, points_delta, description)
                 SELECT ?1, ?2, 'REFERRAL_BONUS', 25, ?3
                 WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?2 AND payment_status = 'PAID')`
              ).bind(referrer.id, txRecord.order_id, `Referral bonus from ${txRecord.recipient_phone}`),
              env.DB.prepare(
                `INSERT OR IGNORE INTO loyalty_ledger (customer_id, order_id, entry_type, points_delta, description)
                 SELECT ?1, ?2, 'REFERRAL_BONUS', 15, ?3
                 WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?2 AND payment_status = 'PAID')`
              ).bind(txRecord.customer_id, txRecord.order_id, `Welcome bonus using code ${txRecord.applied_referral_code}`)
            );
          }
        }
      }

      await env.DB.batch(statements);
    } else {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE mpesa_transactions
           SET result_code = ?1, result_desc = ?2, raw_callback_json = ?3, updated_at = datetime('now')
           WHERE id = ?4`
        ).bind(resultCode, resultDesc, JSON.stringify(payload), txRecord.mpesa_tx_id),

        env.DB.prepare(
          `UPDATE orders
           SET payment_status = 'FAILED', fulfillment_status = 'FAILED',
               failure_reason = ?1, updated_at = datetime('now')
           WHERE id = ?2`
        ).bind(`M-Pesa (${resultCode}): ${resultDesc}`, txRecord.order_id)
      ]);
    }

    return jsonResponse({ ResultCode: 0, ResultDesc: "Callback accepted" });
  } catch (err) {
    console.error("M-Pesa Callback Error:", err);
    // Do not acknowledge an unprocessed callback as successful.
    // The provider may retry, while the unique ledger index protects replay.
    return jsonResponse({ ResultCode: 1, ResultDesc: "Callback processing failed" }, 503);
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function constantTimeEqual(a, b) {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let difference = left.length ^ right.length;
  const size = Math.max(left.length, right.length);
  for (let i = 0; i < size; i++) {
    difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return difference === 0;
}
