-- Email platform, stage 1 (plan/phase-polish-1.md P-6, E-P1): the Owlery feature
-- set ported into ee's single-tenant model. Sender domains with DNS verification
-- (BYO-DKIM, MAIL FROM, DMARC), named senders, the sent-mail log with its SES
-- event timeline, the suppression list, and the email module's background jobs
-- (scheduled sends; drained by the global job-queue tick, no second process).
-- Delivery events reach ee through Amazon SNS → POST /api/mail/ses-events.

ALTER TABLE "owlery_settings" ADD COLUMN IF NOT EXISTS "events_status" text DEFAULT 'not_set_up' NOT NULL;
--> statement-breakpoint
ALTER TABLE "owlery_settings" ADD COLUMN IF NOT EXISTS "events_error" text;
--> statement-breakpoint
ALTER TABLE "owlery_settings" ADD COLUMN IF NOT EXISTS "events_topic_arn" text;
--> statement-breakpoint
ALTER TABLE "owlery_settings" ADD COLUMN IF NOT EXISTS "events_callback_url" text;
--> statement-breakpoint
ALTER TABLE "owlery_settings" ADD COLUMN IF NOT EXISTS "config_set" text;
--> statement-breakpoint
ALTER TABLE "owlery_settings" ADD COLUMN IF NOT EXISTS "tracking_config_set" text;
--> statement-breakpoint
ALTER TABLE "owlery_settings" ADD CONSTRAINT "owlery_settings_events_status_check"
	CHECK ("events_status" IN ('not_set_up', 'waiting', 'ready', 'failed'));
--> statement-breakpoint
-- API sends remember their log row, so an idempotent replay answers with the same id.
ALTER TABLE "mail_api_send" ADD COLUMN IF NOT EXISTS "log_id" uuid;
--> statement-breakpoint
ALTER TABLE "mail_api_send" ADD COLUMN IF NOT EXISTS "send_status" text;
--> statement-breakpoint
-- The fake transport keeps the extra headers too (List-Unsubscribe is asserted in e2e).
ALTER TABLE "mail_fake_sent" ADD COLUMN IF NOT EXISTS "headers" jsonb;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"region" text NOT NULL,
	"status" text DEFAULT 'NOT_STARTED' NOT NULL,
	"dkim_selector" text NOT NULL,
	"public_key" text NOT NULL,
	"dkim_status" text DEFAULT 'NOT_STARTED' NOT NULL,
	"mail_from_status" text DEFAULT 'NOT_STARTED' NOT NULL,
	"dmarc_added" boolean DEFAULT false NOT NULL,
	"tracking" boolean DEFAULT false NOT NULL,
	"error_message" text,
	"is_verifying" boolean DEFAULT true NOT NULL,
	"last_checked_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_domains_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_senders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"display_name" text,
	"domain_id" uuid REFERENCES "mail_domains"("id") ON DELETE CASCADE,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_senders_address_unique" UNIQUE("address")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ses_message_id" text,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"from_address" text NOT NULL,
	"to_address" text NOT NULL,
	"reply_to" text,
	"subject" text NOT NULL,
	"html" text,
	"text" text,
	"content_stored" boolean NOT NULL,
	"headers" jsonb,
	"api_key_id" uuid,
	"api_key_name" text,
	"template_id" uuid,
	"contact_id" uuid,
	"flow_id" uuid,
	"scheduled_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_messages_ses_message_id_unique" UNIQUE("ses_message_id"),
	CONSTRAINT "mail_messages_source_check" CHECK ("source" IN ('system', 'agent', 'api', 'test', 'template', 'flow', 'double_opt_in')),
	CONSTRAINT "mail_messages_status_check" CHECK ("status" IN ('scheduled', 'queued', 'sent', 'delivery_delayed', 'bounced', 'rejected', 'rendering_failure', 'delivered', 'opened', 'clicked', 'complained', 'failed', 'cancelled', 'suppressed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_messages_created_idx" ON "mail_messages" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_messages_to_idx" ON "mail_messages" ("to_address");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_message_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL REFERENCES "mail_messages"("id") ON DELETE CASCADE,
	"status" text NOT NULL,
	"detail" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_message_events_message_idx" ON "mail_message_events" ("message_id", "occurred_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"reason" text NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_suppressions_email_unique" UNIQUE("email"),
	CONSTRAINT "mail_suppressions_reason_check" CHECK ("reason" IN ('HARD_BOUNCE', 'COMPLAINT', 'MANUAL'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_jobs_status_check" CHECK ("status" IN ('pending', 'running', 'done', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_jobs_due_idx" ON "mail_jobs" ("status", "run_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_jobs_dedupe_idx" ON "mail_jobs" ("dedupe_key") WHERE "status" IN ('pending', 'running');
