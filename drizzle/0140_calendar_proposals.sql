-- Appointments found in mail (plan/calendar.md §7, K7): the gateway reads a
-- mail received into a personal inbox and, when an appointment was agreed
-- there, files it here as a proposal. Nothing is added or sent on its own
-- (owner, 2026-11-12): only the mailbox holder accepts (→ an event with
-- source `email_proposal` + the iCalendar invitation to the external guests),
-- edits, or dismisses it.
-- Company-level table (no RLS), like calendar_events: only the member it
-- belongs to sees it — decided in modules/calendar/proposals.ts.

CREATE TABLE IF NOT EXISTS "calendar_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" text NOT NULL,
	"mailbox_id" uuid NOT NULL REFERENCES "mailboxes"("id") ON DELETE CASCADE,
	"message_id" uuid NOT NULL REFERENCES "inbox_messages"("id") ON DELETE CASCADE,
	"state" text DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"time_zone" text NOT NULL,
	"location" text,
	"call" text,
	"attendees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"event_id" uuid REFERENCES "calendar_events"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "calendar_proposals_state_check" CHECK ("state" IN ('open', 'accepted', 'dismissed')),
	CONSTRAINT "calendar_proposals_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 300),
	CONSTRAINT "calendar_proposals_location_check" CHECK ("location" IS NULL OR length("location") <= 300),
	CONSTRAINT "calendar_proposals_call_check" CHECK ("call" IS NULL OR length("call") <= 300),
	CONSTRAINT "calendar_proposals_span_check" CHECK ("ends_at" > "starts_at"),
	CONSTRAINT "calendar_proposals_decided_check" CHECK (("state" = 'open') = ("decided_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_proposals_message_uniq" ON "calendar_proposals" ("message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_proposals_member_state_idx" ON "calendar_proposals" ("member_id", "state", "starts_at");
