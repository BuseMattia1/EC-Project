-- Retro Gaming Online Store: PostgreSQL schema (requires PostgreSQL 13+)
-- Money is stored as integer cents.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','admin')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE addresses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  line1       text NOT NULL,
  city        text NOT NULL,
  postal_code text NOT NULL,
  country     text NOT NULL,
  is_default  boolean NOT NULL DEFAULT false
);
CREATE INDEX addresses_user_idx ON addresses(user_id);

CREATE TABLE categories (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  name      text NOT NULL,
  slug      text NOT NULL UNIQUE
);

CREATE TABLE products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES categories(id),
  title       text NOT NULL,
  description text NOT NULL DEFAULT '',
  platform    text NOT NULL,
  genre       text NOT NULL DEFAULT '',
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  search      tsvector GENERATED ALWAYS AS
              (to_tsvector('english', title || ' ' || description)) STORED
);
CREATE INDEX products_search_idx ON products USING GIN (search);
CREATE INDEX products_category_idx ON products(category_id);

CREATE TABLE product_images (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url        text NOT NULL,
  position   int  NOT NULL DEFAULT 0
);
CREATE INDEX product_images_product_idx ON product_images(product_id);

CREATE TABLE product_variants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  condition   text NOT NULL CHECK (condition IN ('Acceptable','Good','Very Good','Mint')),
  price_cents int  NOT NULL CHECK (price_cents >= 0),
  stock_qty   int  NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
  UNIQUE (product_id, condition)
);

CREATE TABLE carts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cart_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id    uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  quantity   int  NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  UNIQUE (cart_id, variant_id)
);

CREATE TABLE orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id),
  shipping_address_id uuid REFERENCES addresses(id) ON DELETE SET NULL,
  shipping_snapshot   jsonb NOT NULL,           -- copy of the address at checkout time
  status              text NOT NULL DEFAULT 'pending_payment'
                      CHECK (status IN ('pending_payment','paid','shipped','delivered','cancelled')),
  delivery_method     text NOT NULL CHECK (delivery_method IN ('standard','express')),
  shipping_cents      int  NOT NULL DEFAULT 0,
  total_cents         int  NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_user_idx ON orders(user_id, created_at DESC);

CREATE TABLE order_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id       uuid NOT NULL REFERENCES product_variants(id),
  quantity         int  NOT NULL CHECK (quantity > 0),
  unit_price_cents int  NOT NULL CHECK (unit_price_cents >= 0)
);
CREATE INDEX order_items_order_idx ON order_items(order_id);

CREATE TABLE payments (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                 uuid NOT NULL REFERENCES orders(id),
  stripe_payment_intent_id text NOT NULL UNIQUE,
  status                   text NOT NULL DEFAULT 'requires_payment'
                           CHECK (status IN ('requires_payment','succeeded','failed','canceled')),
  amount_cents             int  NOT NULL
);
CREATE INDEX payments_order_idx ON payments(order_id);

-- One row per processed Stripe webhook event: makes the webhook idempotent.
CREATE TABLE stripe_events (
  event_id     text PRIMARY KEY,
  payment_id   uuid REFERENCES payments(id),
  type         text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- Audit log of every stock change.
CREATE TABLE stock_movements (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES product_variants(id),
  order_id   uuid REFERENCES orders(id),
  delta      int  NOT NULL,
  reason     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_variant_idx ON stock_movements(variant_id);
