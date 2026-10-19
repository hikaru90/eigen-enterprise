-- The Owlery email module owns Amazon SES delivery: it holds the SES credentials
-- and does all sending. Replaces the Owlery-API settings table from 0087.
-- One row per company. The SES secret access key is stored only as an
-- AES-256-GCM envelope sealed with a key derived from TENANT_MASTER_KEY.

DROP TABLE IF EXISTS "company_mail";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "owlery_settings" (
	"id" text PRIMARY KEY DEFAULT 'owlery' NOT NULL,
	"region" text NOT NULL,
	"access_key_id" text NOT NULL,
	"sealed_secret_access_key" text NOT NULL,
	"email_from" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owlery_settings_singleton" CHECK ("id" = 'owlery')
);
