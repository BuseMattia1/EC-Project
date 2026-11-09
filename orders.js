import { pool, withTx } from '../db.js';
import { config } from '../config.js';
import { cancelPaymentIntent } from './payments.js';

// Puts the reserved quantities of an order back into stock (A7).
// Variants are always touched in id order, same as checkout, to avoid deadlocks.
export async function releaseStock(client, orderId, reason) {
  const { rows } = await client.query(
    'SELECT variant_id, quantity FROM order_items WHERE order_id = $1 ORDER BY variant_id',
    [orderId],
  );
  for (const r of rows) {
    await client.query('UPDATE product_variants SET stock_qty = stock_qty + $1 WHERE id = $2', [
      r.quantity,
      r.variant_id,
    ]);
    await client.query(
      'INSERT INTO stock_movements (variant_id, order_id, delta, reason) VALUES ($1,$2,$3,$4)',
      [r.variant_id, orderId, r.quantity, reason],
    );
  }
}

// Cancels an order only if it is currently in one of the `from` statuses. Returns true if cancelled.
export async function cancelOrder(orderId, { from, reason }) {
  return withTx(async (c) => {
    const { rows } = await c.query('SELECT status FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!rows[0] || !from.includes(rows[0].status)) return false;
    await c.query("UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1", [orderId]);
    await releaseStock(c, orderId, reason);
    return true;
  });
}

// Unpaid orders hold stock; release it after PENDING_TTL_MINUTES.
export async function expireStaleOrders() {
  const { rows } = await pool.query(
    `SELECT o.id, p.stripe_payment_intent_id AS pi
       FROM orders o LEFT JOIN payments p ON p.order_id = o.id
      WHERE o.status = 'pending_payment'
        AND o.created_at < now() - make_interval(mins => $1::int)`,
    [config.pendingTtlMinutes],
  );
  let cancelled = 0;
  for (const r of rows) {
    if (await cancelOrder(r.id, { from: ['pending_payment'], reason: 'expired' })) {
      cancelled += 1;
      await cancelPaymentIntent(r.pi);
    }
  }
  return cancelled;
}

const ORDER_SELECT = `
  SELECT o.id, o.status, o.delivery_method, o.shipping_cents, o.total_cents, o.created_at,
         o.shipping_snapshot,
         COALESCE(json_agg(json_build_object(
           'title', p.title, 'condition', v.condition,
           'quantity', oi.quantity, 'unitPriceCents', oi.unit_price_cents)
           ORDER BY p.title) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN product_variants v ON v.id = oi.variant_id
    LEFT JOIN products p ON p.id = v.product_id`;

export async function listOrders(db, { userId, orderId, status } = {}) {
  const where = [];
  const params = [];
  if (userId) where.push(`o.user_id = $${params.push(userId)}`);
  if (orderId) where.push(`o.id = $${params.push(orderId)}`);
  if (status) where.push(`o.status = $${params.push(status)}`);
  const sql = `${ORDER_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               GROUP BY o.id ORDER BY o.created_at DESC`;
  const { rows } = await db.query(sql, params);
  return rows;
}
