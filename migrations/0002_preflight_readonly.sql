-- Run against staging first. Read-only; do not mutate payment records.
-- Any returned row from the first two queries blocks migration approval.

-- Existing duplicates would make the unique index migration fail.
SELECT customer_id, order_id, entry_type, COUNT(*) AS duplicate_count
FROM loyalty_ledger
WHERE order_id IS NOT NULL AND entry_type != 'ADMIN_ADJUST'
GROUP BY customer_id, order_id, entry_type
HAVING COUNT(*) > 1;

-- Loyalty entries whose order was never paid require investigation.
SELECT l.customer_id, l.order_id, l.entry_type, o.payment_status
FROM loyalty_ledger l
LEFT JOIN orders o ON o.id = l.order_id
WHERE l.order_id IS NOT NULL
  AND l.entry_type IN ('EARN_PURCHASE', 'REFERRAL_BONUS', 'REDEEM_DISCOUNT')
  AND (o.id IS NULL OR o.payment_status NOT IN ('PAID', 'REFUNDED'));

-- Compare stored balances to net ledger entries; differences may be legitimate
-- historical administrative adjustments and must be reviewed, not overwritten.
SELECT c.id AS customer_id, c.loyalty_points AS stored_points,
       COALESCE(SUM(l.points_delta), 0) AS ledger_points,
       c.loyalty_points - COALESCE(SUM(l.points_delta), 0) AS difference
FROM customers c
LEFT JOIN loyalty_ledger l ON l.customer_id = c.id
GROUP BY c.id, c.loyalty_points
HAVING difference != 0;
