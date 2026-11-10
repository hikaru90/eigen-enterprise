-- Contribute (ported from Eigen's Contribute board): people in the company
-- propose improvements to the app from the top bar; everyone votes; an agent
-- picks proposals up through the contribute.* kernel tools and moves them
-- requested → in_progress → shipped (or declined), with a note.
-- Company-level tables (no RLS), like messages: access is decided in the
-- contribute service (signed-in members propose and vote; owner/admin and
-- the agent manage).

CREATE TABLE IF NOT EXISTS "contributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"area" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"author_id" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"shipped_at" timestamp with time zone,
	CONSTRAINT "contributions_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 2000),
	CONSTRAINT "contributions_kind_check" CHECK ("kind" IN ('idea', 'bug', 'polish')),
	CONSTRAINT "contributions_area_check" CHECK ("area" IN ('dashboard', 'assistant', 'messages', 'website', 'email', 'brand', 'memory', 'drive', 'settings', 'contribute', 'everywhere')),
	CONSTRAINT "contributions_status_check" CHECK ("status" IN ('requested', 'in_progress', 'shipped', 'declined')),
	CONSTRAINT "contributions_note_check" CHECK ("note" IS NULL OR length("note") BETWEEN 1 AND 1000),
	CONSTRAINT "contributions_shipped_check" CHECK (("status" = 'shipped') = ("shipped_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contributions_status_created_idx" ON "contributions" ("status", "created_at" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contribution_votes" (
	"contribution_id" uuid NOT NULL REFERENCES "contributions"("id") ON DELETE CASCADE,
	"user_id" text NOT NULL,
	"direction" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contribution_votes_pk" PRIMARY KEY ("contribution_id", "user_id"),
	CONSTRAINT "contribution_votes_direction_check" CHECK ("direction" IN (-1, 1))
);
