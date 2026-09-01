-- ---------------------------------------------------------------------------
-- 128. Webhook events table for idempotency and audit logs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS webhook_events (
    id SERIAL PRIMARY KEY,
    provider VARCHAR(20) NOT NULL CHECK (provider IN ('stripe', 'paypal')),
    event_id VARCHAR(255) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
    error_message TEXT,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT uq_webhook_provider_event UNIQUE (provider, event_id)
);
