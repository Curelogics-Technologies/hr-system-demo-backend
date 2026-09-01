-- ---------------------------------------------------------------------------
-- 131. Billable headcount ledger.
--      Records every change to the two billed quantities (active employees and
--      registered terminals) so the amount charged can always be explained:
--      who was added or removed, when, and what the running total became.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS billing_headcount_events (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    -- Which billed quantity moved, and in which direction
    resource_type VARCHAR(20) NOT NULL CHECK (resource_type IN ('employee', 'terminal')),
    change_type   VARCHAR(20) NOT NULL CHECK (change_type IN ('added', 'removed')),
    delta         INTEGER NOT NULL,

    -- Running count of that resource type after this event
    resulting_count INTEGER NOT NULL,

    -- Who/what it was, kept denormalised so the ledger survives user deletion
    user_id    INTEGER,
    user_label VARCHAR(255),

    -- Was this change already reflected in a paid invoice?
    billed_at       TIMESTAMPTZ,
    subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,

    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_headcount_company_time
    ON billing_headcount_events(company_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_headcount_unbilled
    ON billing_headcount_events(company_id) WHERE billed_at IS NULL;
