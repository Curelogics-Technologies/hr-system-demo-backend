-- ---------------------------------------------------------------------------
-- 129. Indexes for billing subscriptions, transactions, and webhooks
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_subscriptions_company ON subscriptions(company_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_provider_sub ON subscriptions(provider_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_period_end ON subscriptions(current_period_end);
CREATE INDEX IF NOT EXISTS idx_billing_tx_company ON billing_transactions(company_id);
CREATE INDEX IF NOT EXISTS idx_billing_tx_subscription ON billing_transactions(subscription_id);
CREATE INDEX IF NOT EXISTS idx_billing_tx_status ON billing_transactions(status);
CREATE INDEX IF NOT EXISTS idx_webhook_events_lookup ON webhook_events(provider, event_id);
