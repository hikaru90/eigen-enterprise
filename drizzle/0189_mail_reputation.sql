-- Sender reputation (plan/mail-reputation.md): the ledger of SES Sends, hard bounces and complaints
-- (numbers only, no addresses or content), every reputation check (the history), and the admins'
-- resumes after a hold.
CREATE TABLE IF NOT EXISTS "mail_reputation_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_key" text NOT NULL,
	"ses_message_id" text NOT NULL,
	"kind" text NOT NULL,
	"recipients" integer NOT NULL,
	"origin" text NOT NULL,
	"sender" text,
	"ref" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_reputation_ledger_event_key_unique" UNIQUE("event_key"),
	CONSTRAINT "mail_reputation_ledger_kind_check" CHECK ("kind" IN ('send', 'hard_bounce', 'complaint')),
	CONSTRAINT "mail_reputation_ledger_recipients_check" CHECK ("recipients" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_reputation_ledger_kind_at_idx" ON "mail_reputation_ledger" ("kind", "occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_reputation_ledger_message_idx" ON "mail_reputation_ledger" ("ses_message_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_reputation_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"band" text NOT NULL,
	"recipients" integer NOT NULL,
	"bounces" integer NOT NULL,
	"complaints" integer NOT NULL,
	"bounce_rate" double precision,
	"complaint_rate" double precision,
	"aws_status" text,
	"aws_sending_enabled" boolean,
	"mode" text NOT NULL,
	"aws_error" text,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"slices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_reputation_checks_band_check" CHECK ("band" IN ('unjudged', 'healthy', 'watch', 'held', 'paused'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_reputation_checks_at_idx" ON "mail_reputation_checks" ("checked_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_reputation_resets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reset_by" text NOT NULL,
	"reason" text NOT NULL,
	"band" text NOT NULL,
	"recipients" integer NOT NULL,
	"bounce_rate" double precision,
	"complaint_rate" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
