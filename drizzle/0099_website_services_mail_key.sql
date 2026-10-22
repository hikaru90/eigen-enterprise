-- "Allow this app to send email" (website module, app page). The toggle mints a
-- mail-only API key for the app (user_api_key: mail_send on, mcp off) and seals
-- it into the app's environment as EE_API_KEY through ee. This column remembers
-- which key, so the page shows the state and the key is revoked the moment the
-- toggle goes off or the app is removed. Never the key itself: that is hashed in
-- user_api_key and sealed in ee.

ALTER TABLE "website_services" ADD COLUMN IF NOT EXISTS "mail_key_id" uuid REFERENCES "user_api_key"("id") ON DELETE SET NULL;
