export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    if (!env.MPESA_CALLBACK_SECRET?.trim()) {
      return jsonResponse({ ResultCode: 1, ResultDesc: "Callback unavailable" }, 503);
    }
    const token = new URL(request.url).searchParams.get("token");
    if (token !== env.MPESA_CALLBACK_SECRET) {
      return jsonResponse({ ResultCode: 1, ResultDesc: "Unauthorized callback" }, 401);
    }

    const payload = await request.json();
    const stkCallback = payload?.Body?.stkCallback;

    if (!stkCallback || !stkCallback.CheckoutRequestID) {
      return jsonResponse({ ResultCode: 0, ResultDesc: "Ignored malformed payload" });
    }

    const checkoutRequestId = stkCallback.CheckoutRequestID;
    const resultCode = Number(stkCallback.ResultCode);
    if (stkCallback.ResultCode == null || !Number.isInteger(resultCode)) {
      return jsonResponse({ ResultCode: 1, ResultDesc: "Invalid result code" }, 400);
    }
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
       WHERE mt.checkout_request_id = ?`
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

      if (typeof receiptNumber !== "string" || !receiptNumber.trim() ||
          !Number.isFinite(paidAmount) || Math.abs(paidAmount - expectedAmount) > 0.001) {
        return jsonResponse({ ResultCode: 1, ResultDesc: "Payment requires reconciliation" }, 422);
      }

      // The batch is atomic. Every side effect checks PENDING before the final
      // order update, so another callback's batch becomes a no-op.
      const pending = "EXISTS (SELECT 1 FROM orders WHERE id = ? AND payment_status = 'PENDING')";
      const statements = [
        env.DB.prepare(
          `UPDATE mpesa_transactions
           SET mpesa_receipt_number = ?, transaction_date = ?, result_code = 0,
               result_desc = ?, raw_callback_json = ?, updated_at = datetime('now')
           WHERE id = ? AND ${pending}`
        ).bind(receiptNumber, txDate, resultDesc, JSON.stringify(payload), txRecord.mpesa_tx_id, txRecord.order_id)
      ];

      if (txRecord.customer_id) {
        const netPoints = Number(txRecord.points_earned || 0) - Number(txRecord.points_redeemed || 0);
        statements.push(
          env.DB.prepare(
            `UPDATE customers
             SET loyalty_points = MAX(0, loyalty_points + ?),
                 total_orders_count = total_orders_count + 1,
                 updated_at = datetime('now')
             WHERE id = ? AND ${pending}`
          ).bind(netPoints, txRecord.customer_id, txRecord.order_id),

          env.DB.prepare(
            `INSERT INTO loyalty_ledger (customer_id, order_id, entry_type, points_delta, description)
             SELECT ?, ?, 'EARN_PURCHASE', ?, ? WHERE ${pending}`
          ).bind(
            txRecord.customer_id,
            txRecord.order_id,
            Number(txRecord.points_earned || 0),
            `Earned on bundle order ${txRecord.order_reference}`, txRecord.order_id
          )
        );

        if (Number(txRecord.points_redeemed || 0) > 0) {
          statements.push(
            env.DB.prepare(
              `INSERT INTO loyalty_ledger (customer_id, order_id, entry_type, points_delta, description)
               SELECT ?, ?, 'REDEEM_DISCOUNT', ?, ? WHERE ${pending}`
            ).bind(
              txRecord.customer_id,
              txRecord.order_id,
              -Number(txRecord.points_redeemed),
              `Redeemed KES 10 discount on ${txRecord.order_reference}`, txRecord.order_id
            )
          );
        }

        if (txRecord.applied_referral_code) {
          const referrer = await env.DB.prepare("SELECT id FROM customers WHERE referral_code = ?")
            .bind(txRecord.applied_referral_code)
            .first();

          if (referrer) {
            statements.push(
              env.DB.prepare(
                `UPDATE customers SET loyalty_points = loyalty_points + 25, updated_at = datetime('now') WHERE id = ? AND ${pending}`
              ).bind(referrer.id, txRecord.order_id),
              env.DB.prepare(
                `INSERT INTO loyalty_ledger (customer_id, order_id, entry_type, points_delta, description)
                 SELECT ?, ?, 'REFERRAL_BONUS', 25, ? WHERE ${pending}`
              ).bind(referrer.id, txRecord.order_id, `Referral bonus from ${txRecord.recipient_phone}`, txRecord.order_id),
              env.DB.prepare(
                `UPDATE customers SET loyalty_points = loyalty_points + 15, updated_at = datetime('now') WHERE id = ? AND ${pending}`
              ).bind(txRecord.customer_id, txRecord.order_id),
              env.DB.prepare(
                `INSERT INTO loyalty_ledger (customer_id, order_id, entry_type, points_delta, description)
                 SELECT ?, ?, 'REFERRAL_BONUS', 15, ? WHERE ${pending}`
              ).bind(txRecord.customer_id, txRecord.order_id, `Welcome bonus using code ${txRecord.applied_referral_code}`, txRecord.order_id)
            );
          }
        }
      }

      statements.push(env.DB.prepare(
        `UPDATE orders SET payment_status = 'PAID', updated_at = datetime('now')
         WHERE id = ? AND payment_status = 'PENDING'`
      ).bind(txRecord.order_id));
      await env.DB.batch(statements);
    } else {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE mpesa_transactions
           SET result_code = ?, result_desc = ?, raw_callback_json = ?, updated_at = datetime('now')
           WHERE id = ? AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND payment_status = 'PENDING')`
        ).bind(resultCode, resultDesc, JSON.stringify(payload), txRecord.mpesa_tx_id, txRecord.order_id),

        env.DB.prepare(
          `UPDATE orders
           SET payment_status = 'FAILED', fulfillment_status = 'FAILED',
               failure_reason = ?, updated_at = datetime('now')
           WHERE id = ? AND payment_status = 'PENDING'`
        ).bind(`M-Pesa (${resultCode}): ${resultDesc}`, txRecord.order_id)
      ]);
    }

    return jsonResponse({ ResultCode: 0, ResultDesc: "Callback accepted" });
  } catch {
    console.error("M-Pesa callback processing failed");
    return jsonResponse({ ResultCode: 1, ResultDesc: "Retry callback" }, 503);
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
