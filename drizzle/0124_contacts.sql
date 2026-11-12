-- Contacts (plan/contribute-round-3.md W1): the people the company knows —
-- name, organisation, role/title, how to reach them (channels), where you
-- met, why they matter (tags: partner, customer, funder, investor,
-- production, or your own), last contacted, next follow-up + next step.
-- Not Email's audience lists (those stay in email_* tables).
-- Company-level table (no RLS), like drive_* and contributions: access is
-- decided in the contacts service — a contact is private to its creator plus
-- the company owner and admins, or shared with the whole company.

CREATE TABLE IF NOT EXISTS "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"organisation" text,
	"title" text,
	"channels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"met_how" text,
	"why_relevant" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_contacted_on" date,
	"next_follow_up_on" date,
	"next_step" text,
	"created_by" text NOT NULL,
	"created_by_kind" text NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 200),
	CONSTRAINT "contacts_organisation_check" CHECK ("organisation" IS NULL OR length(btrim("organisation")) BETWEEN 1 AND 200),
	CONSTRAINT "contacts_title_check" CHECK ("title" IS NULL OR length(btrim("title")) BETWEEN 1 AND 200),
	CONSTRAINT "contacts_channels_check" CHECK (jsonb_typeof("channels") = 'array' AND jsonb_array_length("channels") <= 20),
	CONSTRAINT "contacts_met_how_check" CHECK ("met_how" IS NULL OR length(btrim("met_how")) BETWEEN 1 AND 1000),
	CONSTRAINT "contacts_why_relevant_check" CHECK ("why_relevant" IS NULL OR length(btrim("why_relevant")) BETWEEN 1 AND 2000),
	CONSTRAINT "contacts_tags_check" CHECK (cardinality("tags") <= 20),
	CONSTRAINT "contacts_next_step_check" CHECK ("next_step" IS NULL OR length(btrim("next_step")) BETWEEN 1 AND 500),
	CONSTRAINT "contacts_created_by_kind_check" CHECK ("created_by_kind" IN ('user', 'agent'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_created_by_idx" ON "contacts" ("created_by");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_next_follow_up_idx" ON "contacts" ("next_follow_up_on") WHERE "next_follow_up_on" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_tags_idx" ON "contacts" USING gin ("tags");
