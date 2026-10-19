-- Company email delivery, configured in the onboarding (no secrets in env files).
-- One row per company. The provider credential is stored only as an AES-256-GCM
-- envelope sealed with a key derived from the instance TENANT_MASTER_KEY.

CREATE TABLE IF NOT EXISTS "company_mail" (
	"id" text PRIMARY KEY DEFAULT 'mail' NOT NULL,
	"provider" text NOT NULL,
	"base_url" text NOT NULL,
	"email_from" text NOT NULL,
	"sealed_api_key" text NOT NULL,
	"contact_book_id" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_mail_singleton" CHECK ("id" = 'mail'),
	CONSTRAINT "company_mail_provider_check" CHECK ("provider" IN ('owlery'))
);
