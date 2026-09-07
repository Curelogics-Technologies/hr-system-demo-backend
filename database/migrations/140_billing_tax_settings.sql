-- ---------------------------------------------------------------------------
-- 140. Keep the provider's tax rate where the app can see it.
--
--      The rate is created once in the Stripe dashboard and Stripe is what
--      charges it, so Stripe stays the source of truth. But every screen has to
--      quote the same figure the customer will be billed, PayPal needs the
--      percentage written onto its plan, and neither can make an API call in
--      the middle of rendering a total.
--
--      So the rate is mirrored here: read from Stripe, stored, and used from
--      storage. `synced_at` and `sync_error` say how fresh the mirror is, which
--      is the difference between "the rate is 22%" and "the rate was 22% the
--      last time anyone managed to ask".
--
--      One row, always id = 1. The rate is a property of the platform, not of a
--      company: both providers bill through one merchant account.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS billing_tax_settings (
  id                  SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- The Stripe Tax Rate this mirrors. Null means nothing has been linked yet.
  stripe_tax_rate_id  VARCHAR(64),
  -- Percentage points, e.g. 22.00. Zero is a valid, meaningful value: it means
  -- the platform bills net.
  percent             NUMERIC(5, 2) NOT NULL DEFAULT 0,
  -- Stripe's own labels, shown so an admin can confirm they linked the right
  -- rate without leaving the app.
  display_name        VARCHAR(120),
  jurisdiction        VARCHAR(120),
  -- Exclusive means the tax is added on top of the licence price, which is what
  -- the platform bills. An inclusive rate would carve it out of the price
  -- instead, so this is surfaced rather than assumed.
  inclusive           BOOLEAN NOT NULL DEFAULT false,
  active              BOOLEAN NOT NULL DEFAULT true,
  -- 'stripe' when the row was filled from the provider, 'env' when it was
  -- seeded from configuration because Stripe could not be reached.
  source              VARCHAR(16) NOT NULL DEFAULT 'env',
  synced_at           TIMESTAMPTZ,
  -- Why the last sync failed, kept so the UI can say so instead of showing a
  -- stale rate as though it were current.
  sync_error          TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the single row so every later write is a plain UPDATE.
INSERT INTO billing_tax_settings (id, percent, source)
VALUES (1, 0, 'env')
ON CONFLICT (id) DO NOTHING;
