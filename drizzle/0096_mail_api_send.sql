-- POST /api/mail/send (docs/agents/send-mail.md). A key may send mail only when
-- the owner ticked "Can send mail" for it; that tick is the consent, so sends
-- are not approval-gated. mail_api_send holds one row per idempotency key so a
-- retry returns the first result and never sends twice (24h window).

ALTER TABLE "user_api_key" ADD COLUMN IF NOT EXISTS "mail_send" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_api_send" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_id" uuid NOT NULL REFERENCES "user_api_key"("id") ON DELETE CASCADE,
	"idempotency_key" text NOT NULL,
	"body_hash" text NOT NULL,
	"recipient" text NOT NULL,
	"status" text NOT NULL,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_api_send_status_check" CHECK ("status" IN ('pending', 'sent'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_api_send_key_idem_idx" ON "mail_api_send" ("key_id", "idempotency_key");
