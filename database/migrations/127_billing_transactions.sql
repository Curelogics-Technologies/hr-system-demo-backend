-- ---------------------------------------------------------------------------
-- 127. Billing transactions ledger (payment history and receipts)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS billing_transactions (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
    
    -- Gateway info
    provider VARCHAR(20) NOT NULL CHECK (provider IN ('stripe', 'paypal')),
    provider_invoice_id VARCHAR(255),
    provider_payment_id VARCHAR(255),
    
    -- Money (always stored in smallest unit: cents for EUR)
    amount_cents INTEGER NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'EUR',
    
    -- Status
    status VARCHAR(30) NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
    
    -- Human-readable details
    description TEXT,
    
    -- Quantity snapshot at time of charge
    seat_quantity INTEGER,
    device_quantity INTEGER,
    unit_price_employee_cents INTEGER,
    unit_price_device_cents INTEGER,
    
    -- Receipt / Invoice URL
    invoice_url TEXT,
    
    -- Failure info
    failure_code VARCHAR(100),
    failure_message TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 1,
    
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
