-- ---------------------------------------------------------------------------
-- 126. Billing subscriptions table and company billing configuration
-- ---------------------------------------------------------------------------

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS bill_reminder_days_before INTEGER DEFAULT 3,
  ADD COLUMN IF NOT EXISTS grace_period_days INTEGER DEFAULT 3;

CREATE TABLE IF NOT EXISTS subscriptions (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    
    -- Gateway info
    provider VARCHAR(20) NOT NULL CHECK (provider IN ('stripe', 'paypal')),
    provider_subscription_id VARCHAR(255) UNIQUE,
    provider_customer_id VARCHAR(255),
    
    -- Status lifecycle
    status VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete')),
    
    -- Billed quantities (snapshot at last charge)
    seat_quantity INTEGER NOT NULL DEFAULT 0,
    device_quantity INTEGER NOT NULL DEFAULT 0,
    
    -- Deferred reductions (apply at next renewal, not mid-cycle)
    pending_seat_quantity INTEGER,
    pending_device_quantity INTEGER,
    
    -- Price snapshot (captured at checkout, updated at renewal)
    unit_price_employee NUMERIC(10,2) NOT NULL DEFAULT 0,
    unit_price_device NUMERIC(10,2) NOT NULL DEFAULT 0,
    currency VARCHAR(10) NOT NULL DEFAULT 'EUR',
    
    -- Billing cycle
    current_period_start TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
    canceled_at TIMESTAMPTZ,
    
    -- Grace period
    grace_period_ends_at TIMESTAMPTZ,
    
    -- Billing configuration snapshot
    bill_reminder_days_before INTEGER NOT NULL DEFAULT 3,
    grace_period_days INTEGER NOT NULL DEFAULT 3,
    
    -- Checkout tracking
    checkout_session_id VARCHAR(255),
    
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
