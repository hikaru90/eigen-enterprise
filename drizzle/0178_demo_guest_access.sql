-- Login-free demo guest access (plan/phase-demo-company.md): a singleton row
-- (id = 'company'; no row = off). Only takes effect when the internal `demo`
-- module is active, `enabled` is true, and `guest_user_id` is a human `member`
-- (never owner or admin). Visitors click one button on /login and receive a
-- normal session as that shared demo teammate.
-- demo_guest_ai_usage counts AI turns per SHA-256-hashed visitor IP per UTC
-- day so login-free visitors can try a few AI calls (default 2) without raw
-- IPs ever being stored.
-- Company-level tables (no RLS), read through the auth pool like company_join.

CREATE TABLE IF NOT EXISTS "demo_guest_access" (
	"id" text PRIMARY KEY DEFAULT 'company' NOT NULL,
	"enabled" boolean NOT NULL,
	"guest_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
	"ai_calls_per_ip" integer DEFAULT 2 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_guest_access_singleton" CHECK ("id" = 'company'),
	CONSTRAINT "demo_guest_access_ai_calls_range" CHECK ("ai_calls_per_ip" >= 0 AND "ai_calls_per_ip" <= 50)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "demo_guest_ai_usage" (
	"ip_hash" text NOT NULL,
	"day_utc" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("ip_hash", "day_utc"),
	CONSTRAINT "demo_guest_ai_usage_calls_nonneg" CHECK ("calls" >= 0)
);
