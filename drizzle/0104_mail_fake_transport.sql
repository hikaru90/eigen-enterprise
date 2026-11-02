-- Fake mail transport (plan/phase-module-readiness.md E1). Used only when the
-- app runs with MAIL_TRANSPORT=fake (e2e harness, local test server): every
-- mail lands in mail_fake_sent instead of Amazon SES, so a restart or a second
-- request still sees it. mail_fake_identities is the fake's SES identity list
-- (an address is "pending" after creation until a test verifies it).
-- Real installs never write to these tables.

CREATE TABLE IF NOT EXISTS "mail_fake_sent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" text NOT NULL,
	"from_address" text NOT NULL,
	"to_address" text NOT NULL,
	"subject" text NOT NULL,
	"html" text NOT NULL,
	"text" text NOT NULL,
	"reply_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_fake_sent_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_fake_sent_to_created_idx" ON "mail_fake_sent" ("to_address", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_fake_identities" (
	"identity" text PRIMARY KEY NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
