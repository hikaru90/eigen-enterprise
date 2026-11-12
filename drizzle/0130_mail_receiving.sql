-- Receiving mail (plan/email-inbox.md S2/S3): the company's SES receipt
-- wiring, stored next to the delivery-event wiring in owlery_settings —
-- receipt rule set → S3 bucket (raw MIME) → SNS topic → /api/mail/ses-inbound.
-- The ingest checks every notification's topic and bucket against these.
ALTER TABLE "owlery_settings" ADD COLUMN IF NOT EXISTS "receiving_status" text DEFAULT 'not_set_up' NOT NULL;
--> statement-breakpoint
ALTER TABLE "owlery_settings" ADD COLUMN IF NOT EXISTS "receiving_error" text;
--> statement-breakpoint
ALTER TABLE "owlery_settings" ADD COLUMN IF NOT EXISTS "receiving_topic_arn" text;
--> statement-breakpoint
ALTER TABLE "owlery_settings" ADD COLUMN IF NOT EXISTS "receiving_bucket" text;
--> statement-breakpoint
ALTER TABLE "owlery_settings" ADD COLUMN IF NOT EXISTS "receiving_rule_set" text;
--> statement-breakpoint
ALTER TABLE "owlery_settings" ADD COLUMN IF NOT EXISTS "receiving_callback_url" text;
--> statement-breakpoint
ALTER TABLE "owlery_settings" DROP CONSTRAINT IF EXISTS "owlery_settings_receiving_status_check";
--> statement-breakpoint
ALTER TABLE "owlery_settings" ADD CONSTRAINT "owlery_settings_receiving_status_check" CHECK ("receiving_status" IN ('not_set_up', 'waiting', 'ready', 'failed'));
--> statement-breakpoint
-- Per domain: the owner turned on receiving (MX → SES). Off by default: switching
-- a domain's MX moves all of its mail here, so it is always an explicit choice.
ALTER TABLE "mail_domains" ADD COLUMN IF NOT EXISTS "receiving" boolean DEFAULT false NOT NULL;
