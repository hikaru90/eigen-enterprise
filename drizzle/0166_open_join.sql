-- Open join (plan/phase-demo-company.md D1, members.open_join): a company
-- setting, off by default (no row = off). When on, /signup on a claimed ee
-- server lets anyone who verifies their email with the normal sign-in code
-- join as a member. Only the owner or an admin switches it (Settings → Members,
-- members.set_open_join); every switch is a kernel audit event.
-- member_open_join records who came in that way: like an accepted invite, they
-- joined an existing company and skip the company onboarding.
-- Company-level tables (no RLS), read through the auth pool like member_invite.

CREATE TABLE IF NOT EXISTS "company_join" (
	"id" text PRIMARY KEY DEFAULT 'company' NOT NULL,
	"open_join" boolean NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_join_singleton" CHECK ("id" = 'company')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "member_open_join" (
	"user_id" text PRIMARY KEY NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
