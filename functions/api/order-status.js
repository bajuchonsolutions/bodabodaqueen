export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const url = new URL(request.url);
    const ref = (url.searchParams.get("ref") || "").trim().toUpperCase();

    if (!ref) {
      return jsonResponse({ success: false, error: "Order reference is required." }, 400);
    }

    const order = await env.DB.prepare(
      `SELECT
         o.order_reference,
         o.recipient_phone,
         o.amount_kes,
         o.payment_status,
         o.fulfillment_status,
         o.failure_reason,
         mt.mpesa_receipt_number
       FROM orders o
       LEFT JOIN mpesa_transactions mt ON mt.order_id = o.id
       WHERE UPPER(o.order_reference) = ?1`
    )
      .bind(ref)
      .first();

    if (!order) {
      return jsonResponse({ success: false, error: "Order not found." }, 404);
    }

    return jsonResponse({ success: true, ...order });
  } catch (err) {
    console.error("Order Status Error:", err);
    return jsonResponse({ success: false, error: "Failed to check order status." }, 500);
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}
