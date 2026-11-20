-- Apply only after checking for existing duplicate ledger events.
-- This migration is intended for an isolated D1 staging database first.
CREATE UNIQUE INDEX IF NOT EXISTS ux_loyalty_order_event
ON loyalty_ledger(customer_id, order_id, entry_type)
WHERE order_id IS NOT NULL AND entry_type != 'ADMIN_ADJUST';

-- A ledger insert is the only way to change loyalty balances for payment events.
CREATE TRIGGER IF NOT EXISTS trg_loyalty_balance_after_insert
AFTER INSERT ON loyalty_ledger
WHEN NEW.entry_type != 'ADMIN_ADJUST'
BEGIN
  UPDATE customers
  SET loyalty_points = MAX(0, loyalty_points + NEW.points_delta),
      updated_at = datetime('now')
  WHERE id = NEW.customer_id;
END;

-- A successful order counts once, independently of repeated callbacks.
CREATE TRIGGER IF NOT EXISTS trg_order_count_after_paid
AFTER UPDATE OF payment_status ON orders
WHEN OLD.payment_status = 'PENDING' AND NEW.payment_status = 'PAID'
BEGIN
  UPDATE customers SET total_orders_count = total_orders_count + 1,
      updated_at = datetime('now')
  WHERE id = NEW.customer_id;
END;
