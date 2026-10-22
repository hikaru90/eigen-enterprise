-- Key scopes, explicit. Until now every API key could use MCP, and "Can send
-- mail" was a bonus on top — so a key made only to send mail could also read
-- the company brain through /api/mcp. `mcp` makes MCP access a scope of its
-- own. Existing keys keep what they had (default true); a mail-only key, e.g.
-- the one an app gets from the "Allow this app to send email" toggle, is
-- mcp = false, mail_send = true.

ALTER TABLE "user_api_key" ADD COLUMN IF NOT EXISTS "mcp" boolean DEFAULT true NOT NULL;
