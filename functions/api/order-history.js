export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const url = new URL(request.url);
    const rawQuery = (url.searchParams.get("q") || "").trim();

    if (!rawQuery || rawQuery.length < 4) {
      return jsonResponse(
        { success: false, error: "Enter a valid phone number (e.g. 0712345678) or M-Pesa receipt code." },
        400
      );
    }

    const normalizedPhone = normalizeKenyanPhone(rawQuery);
    const upperCode = rawQuery.toUpperCase();

    let results = [];
    let riderProfile = null;

    if (normalizedPhone) {
      const customer = await env.DB.prepare(
        `SELECT phone_number, loyalty_points, total_orders_count, referral_code, referred_by
         FROM customers
         WHERE phone_number = ?1`
      )
        .bind(normalizedPhone)
        .first();

      if (customer) {
        riderProfile = {
          phone_number: customer.phone_number,
          loyalty_points: Number(customer.loyalty_points || 0),
          total_orders_count: Number(customer.total_orders_count || 0),
          referral_code: customer.referral_code || null,
          can_apply_referral: Number(customer.total_orders_count || 0) === 0 && !customer.referred_by,
          can_redeem_discount: Number(customer.loyalty_points || 0) >= 50
        };
      } else {
        riderProfile = {
          phone_number: normalizedPhone,
          loyalty_points: 0,
          total_orders_count: 0,
          referral_code: null,
          can_apply_referral: true,
          can_redeem_discount: false
        };
      }

      const queryRes = await env.DB.prepare(
        `SELECT
           o.order_reference,
           o.recipient_phone,
           o.amount_kes,
           o.discount_kes,
           o.points_earned,
           o.payment_status,
           o.fulfillment_status,
           o.failure_reason,
           datetime(o.created_at, '+3 hours') AS created_at_eat,
           p.name AS product_name,
           p.category AS product_category,
           p.validity_label,
           mt.mpesa_receipt_number
         FROM orders o
         JOIN products p ON p.id = o.product_id
         LEFT JOIN mpesa_transactions mt ON mt.order_id = o.id
         WHERE o.recipient_phone = ?1 OR o.payer_phone = ?1
         ORDER BY o.id DESC
         LIMIT 10`
      )
        .bind(normalizedPhone)
        .all();

      results = queryRes.results || [];
    } else {
      const queryRes = await env.DB.prepare(
        `SELECT
           o.order_reference,
           o.recipient_phone,
           o.amount_kes,
           o.discount_kes,
           o.points_earned,
           o.payment_status,
           o.fulfillment_status,
           o.failure_reason,
           datetime(o.created_at, '+3 hours') AS created_at_eat,
           p.name AS product_name,
           p.category AS product_category,
           p.validity_label,
           mt.mpesa_receipt_number
         FROM orders o
         JOIN products p ON p.id = o.product_id
         LEFT JOIN mpesa_transactions mt ON mt.order_id = o.id
         WHERE UPPER(mt.mpesa_receipt_number) = ?1
            OR UPPER(o.order_reference) = ?1
         ORDER BY o.id DESC
         LIMIT 10`
      )
        .bind(upperCode)
        .all();

      results = queryRes.results || [];
    }

    return jsonResponse({
      success: true,
      count: results.length,
      rider: riderProfile,
      orders: results
    });
  } catch (err) {
    console.error("Order History Lookup Error:", err);
    return jsonResponse({ success: false, error: "Unable to search orders right now." }, 500);
  }
}

function normalizeKenyanPhone(raw) {
  const digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("254") && digits.length === 12) return /^254[71]\d{8}$/.test(digits) ? digits : null;
  if (digits.startsWith("0") && digits.length === 10) return /^0[71]\d{8}$/.test(digits) ? `254${digits.slice(1)}` : null;
  if ((digits.startsWith("7") || digits.startsWith("1")) && digits.length === 9) return `254${digits}`;
  return null;
}

function jsonResponse(payload, status
