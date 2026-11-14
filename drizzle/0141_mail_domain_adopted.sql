-- A sender domain that already exists in the owner's Amazon SES account is
-- adopted instead of refused (owner, 2026-11-14): ee reads Amazon's DKIM setup
-- (Easy DKIM tokens, or a key published elsewhere) and its MAIL FROM, and never
-- deletes the identity at Amazon when the domain is removed here.
ALTER TABLE "mail_domains" ALTER COLUMN "public_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_domains" ADD COLUMN "dkim_tokens" jsonb;--> statement-breakpoint
ALTER TABLE "mail_domains" ADD COLUMN "mail_from_domain" text;--> statement-breakpoint
ALTER TABLE "mail_domains" ADD COLUMN "adopted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "mail_domains" SET "mail_from_domain" = 'mail.' || "name";
