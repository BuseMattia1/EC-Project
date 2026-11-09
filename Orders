import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { HttpError, asyncHandler } from '../middleware/errors.js';
import { validate } from '../middleware/validate.js';

const router = Router();

// A1: catalog, categories, product page. A2: basic search and filters.
router.get(
  '/categories',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT id, name, slug, parent_id FROM categories ORDER BY name');
    res.json({ categories: rows });
  }),
);

const listQuery = z.object({
  search: z.string().trim().max(100).optional(),
  platform: z.string().trim().max(50).optional(),
  genre: z.string().trim().max(50).optional(),
  category: z.string().trim().max(50).optional(),
  inStock: z.enum(['true', 'false']).optional(),
  sort: z.enum(['newest', 'price_asc', 'price_desc']).default('newest'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(48).default(12),
});

const SORTS = {
  newest: 'created_at DESC, title',
  price_asc: 'min_price ASC NULLS LAST, title',
  price_desc: 'min_price DESC NULLS LAST, title',
};

router.get(
  '/products',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const q = req.valid.query;
    const params = [];
    const where = ['p.is_active = true'];
    if (q.search) {
      const n = params.push(q.search);
      where.push(
        `(position(lower($${n}) in lower(p.title)) > 0
          OR position(lower($${n}) in lower(p.platform)) > 0
          OR p.search @@ plainto_tsquery('english', $${n}))`,
      );
    }
    if (q.platform) where.push(`p.platform = $${params.push(q.platform)}`);
    if (q.genre) where.push(`p.genre = $${params.push(q.genre)}`);
    if (q.category) where.push(`c.slug = $${params.push(q.category)}`);
    const having = q.inStock === 'true' ? 'HAVING COALESCE(SUM(v.stock_qty), 0) > 0' : '';
    const limit = params.push(q.pageSize);
    const offset = params.push((q.page - 1) * q.pageSize);

    const { rows } = await query(
      `WITH base AS (
         SELECT p.id, p.title, p.platform, p.genre, p.created_at, c.slug AS category,
                MIN(v.price_cents) AS min_price,
                COALESCE(SUM(v.stock_qty), 0)::int AS total_stock,
                (SELECT url FROM product_images i WHERE i.product_id = p.id
                  ORDER BY position LIMIT 1) AS image_url
           FROM products p
           JOIN categories c ON c.id = p.category_id
           LEFT JOIN product_variants v ON v.product_id = p.id
          WHERE ${where.join(' AND ')}
          GROUP BY p.id, c.slug ${having}
       )
       SELECT *, COUNT(*) OVER()::int AS total FROM base
        ORDER BY ${SORTS[q.sort]} LIMIT $${limit} OFFSET $${offset}`,
      params,
    );
    res.json({
      page: q.page,
      pageSize: q.pageSize,
      total: rows[0]?.total ?? 0,
      products: rows.map(({ total, ...p }) => ({
        id: p.id,
        title: p.title,
        platform: p.platform,
        genre: p.genre,
        category: p.category,
        minPriceCents: p.min_price,
        inStock: p.total_stock > 0,
        imageUrl: p.image_url,
      })),
    });
  }),
);

router.get(
  '/products/:id',
  validate({ params: z.object({ id: z.string().uuid() }) }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;
    const { rows } = await query(
      `SELECT p.id, p.title, p.description, p.platform, p.genre, c.name AS category
         FROM products p JOIN categories c ON c.id = p.category_id
        WHERE p.id = $1 AND p.is_active = true`,
      [id],
    );
    if (!rows[0]) throw new HttpError(404, 'Product not found');
    const [images, variants] = await Promise.all([
      query('SELECT id, url FROM product_images WHERE product_id = $1 ORDER BY position', [id]),
      query(
        `SELECT id, condition, price_cents AS "priceCents", stock_qty AS "stockQty"
           FROM product_variants WHERE product_id = $1 ORDER BY price_cents`,
        [id],
      ),
    ]);
    res.json({ product: { ...rows[0], images: images.rows, variants: variants.rows } });
  }),
);

export default router;
