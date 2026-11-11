import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readSync, unlink } from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, query, withTx } from '../db.js';
import { HttpError, asyncHandler } from '../middleware/errors.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { cancelOrder, listOrders } from '../services/orders.js';
import { cancelPaymentIntent } from '../services/payments.js';

const router = Router();
// A10: every admin route is protected server-side, regardless of what the UI shows.
router.use(requireAuth, requireRole('admin'));

const id = z.string().uuid();
const idParams = z.object({ id });

const productBody = z.object({
  categoryId: id,
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).default(''),
  platform: z.string().trim().min(1).max(50),
  genre: z.string().trim().max(50).default(''),
  isActive: z.boolean().default(true),
});

// ---- Products (A9: CRUD) ----
router.get(
  '/products',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT p.id, p.title, p.platform, p.genre, p.is_active AS "isActive", c.name AS category,
              COALESCE(json_agg(json_build_object('id', v.id, 'condition', v.condition,
                'priceCents', v.price_cents, 'stockQty', v.stock_qty) ORDER BY v.price_cents)
                FILTER (WHERE v.id IS NOT NULL), '[]') AS variants
         FROM products p JOIN categories c ON c.id = p.category_id
         LEFT JOIN product_variants v ON v.product_id = p.id
        GROUP BY p.id, c.name ORDER BY p.title`,
    );
    res.json({ products: rows });
  }),
);

router.post(
  '/products',
  validate({ body: productBody }),
  asyncHandler(async (req, res) => {
    const b = req.valid.body;
    const { rows } = await query(
      `INSERT INTO products (category_id, title, description, platform, genre, is_active)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [b.categoryId, b.title, b.description, b.platform, b.genre, b.isActive],
    );
    res.status(201).json({ id: rows[0].id });
  }),
);

router.put(
  '/products/:id',
  validate({ params: idParams, body: productBody }),
  asyncHandler(async (req, res) => {
    const b = req.valid.body;
    const r = await query(
      `UPDATE products SET category_id=$2, title=$3, description=$4, platform=$5, genre=$6, is_active=$7
        WHERE id=$1`,
      [req.valid.params.id, b.categoryId, b.title, b.description, b.platform, b.genre, b.isActive],
    );
    if (!r.rowCount) throw new HttpError(404, 'Product not found');
    res.json({ ok: true });
  }),
);

// "Delete" archives the product: order history keeps pointing at it.
router.delete(
  '/products/:id',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const r = await query('UPDATE products SET is_active = false WHERE id = $1', [req.valid.params.id]);
    if (!r.rowCount) throw new HttpError(404, 'Product not found');
    res.json({ ok: true });
  }),
);

// ---- Variants and stock (A7) ----
router.post(
  '/products/:id/variants',
  validate({
    params: idParams,
    body: z.object({
      condition: z.enum(['Acceptable', 'Good', 'Very Good', 'Mint']),
      priceCents: z.number().int().min(0),
      stockQty: z.number().int().min(0).default(0),
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.valid.body;
    const variant = await withTx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO product_variants (product_id, condition, price_cents, stock_qty)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [req.valid.params.id, b.condition, b.priceCents, b.stockQty],
      );
      if (b.stockQty > 0) {
        await c.query(
          `INSERT INTO stock_movements (variant_id, delta, reason) VALUES ($1,$2,'initial')`,
          [rows[0].id, b.stockQty],
        );
      }
      return rows[0];
    });
    res.status(201).json({ id: variant.id });
  }),
);

router.put(
  '/variants/:id',
  validate({ params: idParams, body: z.object({ priceCents: z.number().int().min(0) }) }),
  asyncHandler(async (req, res) => {
    const r = await query('UPDATE product_variants SET price_cents = $2 WHERE id = $1', [
      req.valid.params.id,
      req.valid.body.priceCents,
    ]);
    if (!r.rowCount) throw new HttpError(404, 'Variant not found');
    res.json({ ok: true });
  }),
);

// Relative stock change (e.g. +5 received, -1 damaged). Never goes below zero.
router.patch(
  '/variants/:id/stock',
  validate({
    params: idParams,
    body: z.object({
      delta: z.number().int().refine((n) => n !== 0, 'Delta must not be 0'),
      reason: z.string().trim().min(1).max(100).default('manual_adjustment'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { delta, reason } = req.valid.body;
    const stockQty = await withTx(async (c) => {
      const r = await c.query(
        `UPDATE product_variants SET stock_qty = stock_qty + $1::int
          WHERE id = $2 AND stock_qty + $1::int >= 0 RETURNING stock_qty`,
        [delta, req.valid.params.id],
      );
      if (!r.rowCount) {
        const exists = await c.query('SELECT 1 FROM product_variants WHERE id = $1', [req.valid.params.id]);
        throw exists.rowCount ? new HttpError(409, 'Stock cannot go below zero') : new HttpError(404, 'Variant not found');
      }
      await c.query('INSERT INTO stock_movements (variant_id, delta, reason) VALUES ($1,$2,$3)', [
        req.valid.params.id,
        delta,
        reason,
      ]);
      return r.rows[0].stock_qty;
    });
    res.json({ stockQty });
  }),
);

// ---- Image upload (A9) ----
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.uploadDir),
    filename: (req, file, cb) => cb(null, randomBytes(16).toString('hex') + EXT[file.mimetype]),
  }),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) =>
    EXT[file.mimetype] ? cb(null, true) : cb(new HttpError(400, 'Only JPEG, PNG or WebP images are allowed')),
});

// The mimetype comes from the client, so also check the file's magic bytes.
function looksLikeImage(file) {
  const buf = Buffer.alloc(12);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, 12, 0);
  } finally {
    closeSync(fd);
  }
  const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const png = buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const webp = buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
  return jpeg || png || webp;
}

router.post(
  '/products/:id/images',
  validate({ params: idParams }),
  upload.single('image'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Image file is required (field "image")');
    if (!looksLikeImage(req.file.path)) {
      unlink(req.file.path, () => {});
      throw new HttpError(400, 'File is not a valid image');
    }
    const url = `/uploads/${path.basename(req.file.path)}`;
    const { rows } = await query(
      `INSERT INTO product_images (product_id, url, position)
       VALUES ($1, $2, COALESCE((SELECT MAX(position) + 1 FROM product_images WHERE product_id = $1), 0))
       RETURNING id`,
      [req.valid.params.id, url],
    );
    res.status(201).json({ id: rows[0].id, url });
  }),
);

router.delete(
  '/images/:id',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const { rows } = await query('DELETE FROM product_images WHERE id = $1 RETURNING url', [req.valid.params.id]);
    if (!rows[0]) throw new HttpError(404, 'Image not found');
    unlink(path.join(config.uploadDir, path.basename(rows[0].url)), () => {});
    res.json({ ok: true });
  }),
);

// ---- Orders (A9: order statuses) ----
const STATUSES = ['pending_payment', 'paid', 'shipped', 'delivered', 'cancelled'];
const TRANSITIONS = {
  pending_payment: ['cancelled'],
  paid: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

router.get(
  '/orders',
  validate({ query: z.object({ status: z.enum(STATUSES).optional() }) }),
  asyncHandler(async (req, res) => {
    res.json({ orders: await listOrders(pool, { status: req.valid.query.status }) });
  }),
);

router.patch(
  '/orders/:id/status',
  validate({ params: idParams, body: z.object({ status: z.enum(STATUSES) }) }),
  asyncHandler(async (req, res) => {
    const orderId = req.valid.params.id;
    const next = req.valid.body.status;
    const cur = await query('SELECT status FROM orders WHERE id = $1', [orderId]);
    if (!cur.rows[0]) throw new HttpError(404, 'Order not found');
    const from = cur.rows[0].status;
    if (!TRANSITIONS[from].includes(next)) {
      throw new HttpError(409, `Cannot change status from ${from} to ${next}`);
    }
    if (next === 'cancelled') {
      // Returns the reserved stock. A paid order also needs a manual refund in Stripe.
      const done = await cancelOrder(orderId, { from: [from], reason: 'cancelled_by_admin' });
      if (!done) throw new HttpError(409, 'Order status changed, please reload');
      const pay = await query('SELECT stripe_payment_intent_id AS pi FROM payments WHERE order_id = $1', [orderId]);
      if (from === 'pending_payment') await cancelPaymentIntent(pay.rows[0]?.pi);
    } else {
      const r = await query(
        'UPDATE orders SET status = $2, updated_at = now() WHERE id = $1 AND status = $3',
        [orderId, next, from],
      );
      if (!r.rowCount) throw new HttpError(409, 'Order status changed, please reload');
    }
    res.json({ ok: true, status: next });
  }),
);

export default router;
