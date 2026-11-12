-- The company's identity (Contribute 6a3b17ba): its name and logo, shown at the
-- top left of the app and edited in Settings → Company by the owner and admins.
-- One row per company (like company_mail). The name set here wins over the
-- founding interview's answer; the logo bytes live content-addressed on disk
-- (<drive dir>/company, like profile pictures), the row names them by SHA-256.
-- Company-level table (no RLS): access is decided by the capability guard.

CREATE TABLE IF NOT EXISTS "company_profile" (
	"id" text PRIMARY KEY DEFAULT 'company' NOT NULL,
	"name" text,
	"logo_sha256" text,
	"logo_mime" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_profile_singleton" CHECK ("id" = 'company'),
	CONSTRAINT "company_profile_name_check" CHECK ("name" IS NULL OR length(btrim("name")) BETWEEN 1 AND 80),
	CONSTRAINT "company_profile_logo_pair_check" CHECK (("logo_sha256" IS NULL) = ("logo_mime" IS NULL)),
	CONSTRAINT "company_profile_logo_sha_check" CHECK ("logo_sha256" IS NULL OR "logo_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "company_profile_logo_mime_check" CHECK ("logo_mime" IS NULL OR "logo_mime" IN ('image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'))
);
