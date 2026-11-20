export async function onRequestPost(context) {
  const { request, env } = context;

  const callbackUrl = URL.parse(env.MPESA_CALLBACK_URL || "");
  if (!env.MPESA_CALLBACK_SECRET?.trim() || callbackUrl?.protocol !== "https:" ||
      callbackUrl.searchParams.get("token") !== env.MPESA_CALLBACK_SECRET) {
    return jsonResponse({ success: false, error: "Payment is temporarily unavailable." }, 503);
  }

  try {
    try {
      const storeState = await env.DB.prepare(
        "SELECT setting_value FROM system_settings WHERE setting_key = 'STORE_STATUS'"
      ).first();
      if (storeState && storeState.setting_value !== "OPEN") {
        return jsonResponse(
          { success: false, error: "Bundle restocking in progress. Please try again in a few minutes." },
          503
        );
      }
    } catch {}

    const body = await request.json();
    const { product_id, payer_phone, recipient_phone, referral_code, redeem_points } = body;

    if (!product_id || !payer_phone) {
      return jsonResponse({ success: false, error: "product_id and payer_phone are required." }, 400);
    }

    const normalizedPayer = normalizeKenyanPhone(payer_phone);
    const normalizedRecipient = normalizeKenyanPhone(recipient_phone || payer_phone);

    if (!normalizedPayer || !normalizedRecipient) {
      return jsonResponse(
        { success: false, error: "Invalid Kenyan phone number. Use 07XXXXXXXX, 01XXXXXXXX, or 2547XXXXXXXX." },
        400
      );
    }

    // Per-Phone D1 Rate Limiter
    const pendingWindow = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt
       FROM orders
       WHERE (payer_phone = ?1 OR recipient_phone = ?2)
         AND payment_status = 'PENDING'
         AND created_at >= datetime('now', '-2 minutes')`
    )
      .bind(normalizedPayer, normalizedRecipient)
      .first();

    if (pendingWindow && Number(pendingWindow.cnt) >= 2) {
      return jsonResponse(
        {
          success: false,
          error: "You already have a pending M-Pesa prompt on your phone. Enter your PIN or wait 2 minutes before retrying."
        },
        429
      );
    }

    const burstWindow = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt
       FROM orders
       WHERE (payer_phone = ?1 OR recipient_phone = ?2)
         AND created_at >= datetime('now', '-10 minutes')`
    )
      .bind(normalizedPayer, normalizedRecipient)
      .first();

    if (burstWindow && Number(burstWindow.cnt) >= 5) {
      return jsonResponse(
        {
          success: false,
          error: "Too many M-Pesa prompt attempts for this number. Please wait 10 minutes before trying again."
        },
        429
      );
    }

    const product = await env.DB.prepare(
      "SELECT id, sku, name, selling_price, cost_price, is_active FROM products WHERE id = ?1"
    )
      .bind(product_id)
      .first();

    if (!product || product.is_active !== 1) {
      return jsonResponse({ success: false, error: "Selected bundle is unavailable." }, 404);
    }

    let customer = await env.DB.prepare(
      "SELECT id, phone_number, loyalty_points, total_orders_count, referral_code, referred_by FROM customers WHERE phone_number = ?1"
    )
      .bind(normalizedRecipient)
      .first();

    if (!customer) {
      const newRefCode = generateRiderReferralCode(normalizedRecipient);
      await env.DB.prepare(`INSERT INTO customers (phone_number, referral_code) VALUES (?1, ?2)`)
        .bind(normalizedRecipient, newRefCode)
        .run();

      customer = await env.DB.prepare(
        "SELECT id, phone_number, loyalty_points, total_orders_count, referral_code, referred_by FROM customers WHERE phone_number = ?1"
      )
        .bind(normalizedRecipient)
        .first();
    } else if (!customer.referral_code) {
      const newRefCode = generateRiderReferralCode(normalizedRecipient);
      await env.DB.prepare("UPDATE customers SET referral_code = ?1 WHERE id = ?2")
        .bind(newRefCode, customer.id)
        .run();
      customer.referral_code = newRefCode;
    }

    let validReferralCode = null;
    if (referral_code && customer.total_orders_count === 0 && !customer.referred_by) {
      const cleanCode = String(referral_code).trim().toUpperCase();
      if (cleanCode !== customer.referral_code) {
        const referrer = await env.DB.prepare(
          "SELECT id, referral_code FROM customers WHERE referral_code = ?1 AND is_active = 1"
        )
          .bind(cleanCode)
          .first();

        if (referrer) {
          validReferralCode = referrer.referral_code;
          await env.DB.prepare("UPDATE customers SET referred_by = ?1 WHERE id = ?2")
            .bind(validReferralCode, customer.id)
            .run();
        }
      }
    }

    const basePrice = Math.ceil(Number(product.selling_price));
    let pointsRedeemed = 0;
    let discountKes = 0;

    if (redeem_points && customer.loyalty_points >= 50 && basePrice >= 20) {
      pointsRedeemed = 50;
      discountKes = 10;
    }

    const finalAmountKes = Math.max(basePrice - discountKes, 10);
    const pointsToEarn = Math.max(Math.floor(finalAmountKes / 10), 1);
    const orderReference = generateOrderReference();

    const insertOrderResult = await env.DB.prepare(
      `INSERT INTO orders (
        order_reference, customer_id, payer_phone, recipient_phone,
        product_id, amount_kes, cost_kes, points_earned, points_redeemed,
        discount_kes, applied_referral_code, payment_method, payment_status, fulfillment_status
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'MPESA_STK', 'PENDING', 'QUEUED')`
    )
      .bind(
        orderReference,
        customer.id,
        normalizedPayer,
        normalizedRecipient,
        product.id,
        finalAmountKes,
        product.cost_price,
        pointsToEarn,
        pointsRedeemed,
        discountKes,
        validReferralCode
      )
      .run();

    const orderId = insertOrderResult.meta.last_row_id;

    const baseUrl =
      env.MPESA_ENV === "production"
        ? "https://api.safaricom.co.ke"
        : "https://sandbox.safaricom.co.ke";

    const accessToken = await getDarajaAccessToken(
      baseUrl,
      env.MPESA_CONSUMER_KEY,
      env.MPESA_CONSUMER_SECRET
    );

    const timestamp = getNairobiTimestamp();
    const password = btoa(`${env.MPESA_SHORTCODE}${env.MPESA_PASSKEY}${timestamp}`);

    const stkPayload = {
      BusinessShortCode: env.MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: env.MPESA_TRANSACTION_TYPE || "CustomerPayBillOnline",
      Amount: finalAmountKes,
      PartyA: normalizedPayer,
      PartyB: env.MPESA_TILL_OR_ACCOUNT || env.MPESA_SHORTCODE,
      PhoneNumber: normalizedPayer,
      CallBackURL: callbackUrl.href,
      AccountReference: orderReference,
      TransactionDesc: `BodaBodaQueen ${product.sku}`
    };

    const stkRes = await fetch(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(stkPayload)
    });

    const stkData = await stkRes.json();

    if (!stkRes.ok || stkData.ResponseCode !== "0") {
      const errorMsg =
        stkData.errorMessage ||
        stkData.ResponseDescription ||
        "Safaricom M-Pesa STK Push failed to initiate.";

      await env.DB.prepare(
        `UPDATE orders
         SET payment_status = 'FAILED', fulfillment_status = 'FAILED',
             failure_reason = ?1, updated_at = datetime('now')
         WHERE id = ?2`
      )
        .bind(errorMsg, orderId)
        .run();

      return jsonResponse({ success: false, error: errorMsg, order_reference: orderReference }, 502);
    }

    await env.DB.prepare(
      `INSERT INTO mpesa_transactions (
        order_id, merchant_request_id, checkout_request_id, phone_number, amount
      ) VALUES (?1, ?2, ?3, ?4, ?5)`
    )
      .bind(orderId, stkData.MerchantRequestID, stkData.CheckoutRequestID, normalizedPayer, finalAmountKes)
      .run();

    return jsonResponse({
      success: true,
      message: "M-Pesa prompt sent. Enter your M-Pesa PIN on your phone.",
      order_reference: orderReference,
      checkout_request_id: stkData.CheckoutRequestID,
      amount_kes: finalAmountKes,
      discount_kes: discountKes,
      points_to_earn: pointsToEarn,
      rider_referral_code: customer.referral_code,
      current_points: customer.loyalty_points
    });
  } catch (err) {
    console.error("Checkout Error:", err);
    return jsonResponse({ success: false, error: "Internal server error processing checkout." }, 500);
  }
}

async function getDarajaAccessToken(baseUrl, consumerKey, consumerSecret) {
  const credentials = btoa(`${consumerKey}:${consumerSecret}`);
  const response = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    method: "GET",
    headers: { Authorization: `Basic ${credentials}` }
  });
  if (!response.ok) throw new Error(`Daraja OAuth failed: ${response.status}`);
  const data = await response.json();
  return data.access_token;
}

function normalizeKenyanPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("254") && digits.length === 12) return /^254[71]\d{8}$/.test(digits) ? digits : null;
  if (digits.startsWith("0") && digits.length === 10) return /^0[71]\d{8}$/.test(digits) ? `254${digits.slice(1)}` : null;
  if ((digits.startsWith("7") || digits.startsWith("1")) && digits.length === 9) return `254${digits}`;
  return null;
}

function getNairobiTimestamp() {
  const now = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    now.getUTCFullYear() +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds())
  );
}

function generateOrderReference() {
  const now = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const yy = String(now.getUTCFullYear()).slice(-2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `BBQ-${yy}${mm}${dd}-${rand}`;
}

function generateRiderReferralCode(normalizedPhone) {
  const suffix = normalizedPhone.slice(-4);
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const randLetters =
    chars[Math.floor(Math.random() * chars.length)] +
    chars[Math.floor(Math.random() * chars.length)];
  return `BBQ-${randLetters}${suffix}`;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
