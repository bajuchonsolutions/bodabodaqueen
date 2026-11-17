PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS system_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO system_settings (setting_key, setting_value) VALUES
  ('STORE_STATUS', 'OPEN'),
  ('SIM_FLOAT_BALANCE', '0');

CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_number TEXT NOT NULL UNIQUE,
    full_name TEXT,
    wallet_balance REAL NOT NULL DEFAULT 0.00,
    loyalty_points INTEGER NOT NULL DEFAULT 0,
    total_orders_count INTEGER NOT NULL DEFAULT 0,
    referral_code TEXT UNIQUE,
    referred_by TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT NOT NULL UNIQUE,
    provider_package_code TEXT NOT NULL,
    ussd_template TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL CHECK (category IN ('DATA', 'SMS', 'VOICE', 'COMBO')),
    name TEXT NOT NULL,
    description TEXT,
    validity_label TEXT NOT NULL,
    cost_price REAL NOT NULL,
    selling_price REAL NOT NULL,
    is_featured INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 100,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_reference TEXT NOT NULL UNIQUE,
    customer_id INTEGER,
    payer_phone TEXT NOT NULL,
    recipient_phone TEXT NOT NULL,
    product_id INTEGER NOT NULL,
    amount_kes REAL NOT NULL,
    cost_kes REAL NOT NULL,
    points_earned INTEGER NOT NULL DEFAULT 0,
    points_redeemed INTEGER NOT NULL DEFAULT 0,
    discount_kes REAL NOT NULL DEFAULT 0.00,
    applied_referral_code TEXT,
    payment_method TEXT NOT NULL DEFAULT 'MPESA_STK',
    payment_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (payment_status IN ('PENDING', 'PAID', 'FAILED', 'REFUNDED')),
    fulfillment_status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (fulfillment_status IN ('QUEUED', 'PROCESSING', 'DELIVERED', 'FAILED')),
    failure_reason TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS mpesa_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    merchant_request_id TEXT NOT NULL,
    checkout_request_id TEXT NOT NULL UNIQUE,
    mpesa_receipt_number TEXT UNIQUE,
    phone_number TEXT NOT NULL,
    amount REAL NOT NULL,
    transaction_date TEXT,
    result_code INTEGER,
    result_desc TEXT,
    raw_callback_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS fulfillment_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    vendor_name TEXT NOT NULL,
    vendor_transaction_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'FAILED')),
    request_payload TEXT,
    response_payload TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS loyalty_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    order_id INTEGER,
    entry_type TEXT NOT NULL CHECK (entry_type IN ('EARN_PURCHASE', 'REFERRAL_BONUS', 'REDEEM_DISCOUNT', 'ADMIN_ADJUST')),
    points_delta INTEGER NOT NULL,
    description TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_products_active_cat ON products(is_active, category, sort_order);
CREATE INDEX IF NOT EXISTS idx_orders_recipient ON orders(recipient_phone);
CREATE INDEX IF NOT EXISTS idx_orders_payer ON orders(payer_phone);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_ratelimit ON orders(payer_phone, recipient_phone, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_fulfillment ON orders(payment_status, fulfillment_status, id);
CREATE INDEX IF NOT EXISTS idx_mpesa_receipt ON mpesa_transactions(mpesa_receipt_number);
CREATE INDEX IF NOT EXISTS idx_loyalty_customer ON loyalty_ledger(customer_id, id DESC);

INSERT OR IGNORE INTO products (sku, provider_package_code, ussd_template, category, name, description, validity_label, cost_price, selling_price, is_featured, sort_order) VALUES
  ('SAF-COMBO-BODA-24H', 'PKG_C500_30M_24', '*180*5*2*{PHONE}*1#', 'COMBO', 'Boda Rider Daily Pack', '500MB Data + 30 Mins + 100 SMS (24 Hrs)', '24 Hours', 42.00, 55.00, 1, 10),
  ('SAF-DATA-1GB-1H', 'PKG_D1000_1H', '*180*5*1*1*{PHONE}*1#', 'DATA', '1GB Hourly Data', '1GB high-speed data valid for 1 hour', '1 Hour', 14.00, 19.00, 1, 20),
  ('SAF-DATA-250MB-24H', 'PKG_D250_24', '*180*5*1*2*{PHONE}*1#', 'DATA', '250MB Daily Data', 'Fast 4G/5G browsing valid for 24 hours', '24 Hours', 15.00, 20.00, 0, 30),
  ('SAF-DATA-1500MB-24H', 'PKG_D1500_24', '*180*5*1*3*{PHONE}*1#', 'DATA', '1.5GB Daily Bundle', '1.5GB data valid for 24 hours', '24 Hours', 38.00, 50.00, 1, 40),
  ('SAF-VOICE-45M-24H', 'PKG_V45_24', '*180*5*3*1*{PHONE}*1#', 'VOICE', '45 Mins Daily Talktime', '45 minutes all-network calls for 24 hours', '24 Hours', 38.00, 50.00, 1, 50),
  ('SAF-SMS-200-24H', 'PKG_S200_24', '*180*5*4*1*{PHONE}*1#', 'SMS', '200 Daily SMS', '200 SMS to all networks for 24 hours', '24 Hours', 7.00, 10.00, 0, 60),
  ('SAF-SMS-1000-7D', 'PKG_S1000_7D', '*180*5*4*2*{PHONE}*1#', 'SMS', '1,000 Weekly SMS', '1,000 SMS to all networks for 7 days', '7 Days', 22.00, 30.00, 1, 70);
