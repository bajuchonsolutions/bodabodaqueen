export async function onRequestGet(context) {
  const { env } = context;

  try {
    const storeState = await env.DB.prepare(
      "SELECT setting_value FROM system_settings WHERE setting_key = 'STORE_STATUS'"
    ).first();

    if (storeState && storeState.setting_value !== "OPEN") {
      return jsonResponse({ success: true, store_status: storeState.setting_value, products: [] });
    }

    const { results } = await env.DB.prepare(
      `SELECT id, sku, category, name, description, validity_label, selling_price, is_featured
       FROM products
       WHERE is_active = 1
       ORDER BY sort_order ASC, id ASC`
    ).all();

    return jsonResponse({
      success: true,
      store_status: "OPEN",
      products: results || []
    });
  } catch (err) {
    console.error("Products GET Error:", err);
    return jsonResponse({ success: false, error: "Failed to load bundle catalog." }, 500);
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=30"
    }
  });
}
