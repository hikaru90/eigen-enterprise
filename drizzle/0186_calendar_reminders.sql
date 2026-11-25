-- Calendar reminders (plan/calendar.md K3, Contribute df14e05a): a push to the phone
-- before an event starts. Each member chooses how many minutes before (10 until they
-- choose; null = no reminders). Sent reminders are claimed per occurrence and person,
-- so none goes out twice.
ALTER TABLE "calendar_preferences" ADD COLUMN IF NOT EXISTS "reminder_minutes" integer DEFAULT 10;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_reminders_sent" (
	"event_id" uuid NOT NULL REFERENCES "calendar_events"("id") ON DELETE CASCADE,
	"occurrence_start" timestamp with time zone NOT NULL,
	"member_id" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("event_id", "occurrence_start", "member_id")
);
