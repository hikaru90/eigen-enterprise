-- Reminders (Contribute 2c414719): a person's own recurring reminders — fixed
-- weekdays at a wall time in their time zone. Private to the person: row-level
-- security on user_id (src/lib/server/db/enable_rls.sql), like thoughts and
-- notes. An occurrence is computed, never stored: every occurrence at or before
-- handled_through is handled (ticked off, or skipped while paused or after the
-- rhythm changed); the ones after it up to now are due, and wait under the
-- person's Needs you until ticked off (snoozed_until hides them for a while).
CREATE TABLE IF NOT EXISTS "reminders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
	"title" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"weekdays" text[] NOT NULL,
	"time_of_day" text NOT NULL,
	"time_zone" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"handled_through" timestamp with time zone NOT NULL,
	"snoozed_until" timestamp with time zone,
	"created_via" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminders_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 200),
	CONSTRAINT "reminders_note_check" CHECK (length("note") <= 2000),
	CONSTRAINT "reminders_weekdays_check" CHECK (
		cardinality("weekdays") BETWEEN 1 AND 7
		AND "weekdays" <@ ARRAY['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']::text[]
	),
	CONSTRAINT "reminders_time_check" CHECK ("time_of_day" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "reminders_status_check" CHECK ("status" IN ('active', 'paused')),
	CONSTRAINT "reminders_created_via_check" CHECK ("created_via" IN ('person', 'assistant'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reminders_user_idx" ON "reminders" ("user_id", "created_at");
--> statement-breakpoint
-- Private from the first deploy on, before enable_rls.sql runs again.
ALTER TABLE "reminders" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "reminders" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS reminders_isolation ON "reminders";
--> statement-breakpoint
CREATE POLICY reminders_isolation ON "reminders"
  FOR ALL
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));
