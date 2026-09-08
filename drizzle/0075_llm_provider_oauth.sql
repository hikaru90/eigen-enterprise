-- OAuth credentials for LLM provider rows (phase-2a: subscription sign-ins).
-- api_key rows keep using api_key/api_key_encrypted; oauth rows store the
-- encrypted access + long-lived refresh tokens and an expiry timestamp.

ALTER TABLE llm_provider_config
  ADD COLUMN IF NOT EXISTS auth_type text NOT NULL DEFAULT 'api_key',
  ADD COLUMN IF NOT EXISTS oauth_access_encrypted text,
  ADD COLUMN IF NOT EXISTS oauth_refresh_encrypted text,
  ADD COLUMN IF NOT EXISTS oauth_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS oauth_meta jsonb;

-- app-level check constraints survive dump/restore better than enum churn;
-- provider itself stays free-form text so new providers never need migrations.
ALTER TABLE llm_provider_config
  DROP CONSTRAINT IF EXISTS llm_provider_config_auth_type_check;
ALTER TABLE llm_provider_config
  ADD CONSTRAINT llm_provider_config_auth_type_check
  CHECK (auth_type IN ('api_key', 'oauth'));
