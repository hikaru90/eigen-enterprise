-- Calendar (plan/calendar.md K1): each member's own events, their attendees
-- and the member's default visibility for new events.
-- Company-level tables (no RLS), like contacts and drive_*: who sees what is
-- decided in the calendar service (modules/calendar/service.ts) — the event's
-- owner and its member attendees see it in full; everyone else sees the
-- title + time (company), "Busy" + time (busy) or "Out of office" + time
-- (private). The owner and admins get no extra view.
--
-- Recurrence: a series is one row with an RRULE (expanded on read in the
-- event's time zone) plus `exdates` (instance starts removed). An instance
-- changed on its own is an override row: `recurrence_id` = the series,
-- `original_start` = the instance start it replaces.
-- `source` + `external_id` + `etag` are for the Google / Microsoft sync and
-- for events accepted from an email proposal (K5–K7).

CREATE TABLE IF NOT EXISTS "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"time_zone" text NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"location" text,
	"call_id" text,
	"visibility" text DEFAULT 'busy' NOT NULL,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"source" text DEFAULT 'local' NOT NULL,
	"external_id" text,
	"etag" text,
	"rrule" text,
	"exdates" timestamp with time zone[] DEFAULT '{}'::timestamptz[] NOT NULL,
	"recurrence_ends_at" timestamp with time zone,
	"recurrence_id" uuid REFERENCES "calendar_events"("id") ON DELETE CASCADE,
	"original_start" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_events_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 300),
	CONSTRAINT "calendar_events_notes_check" CHECK ("notes" IS NULL OR length("notes") <= 5000),
	CONSTRAINT "calendar_events_location_check" CHECK ("location" IS NULL OR length(btrim("location")) BETWEEN 1 AND 300),
	CONSTRAINT "calendar_events_span_check" CHECK ("ends_at" >= "starts_at"),
	CONSTRAINT "calendar_events_visibility_check" CHECK ("visibility" IN ('company', 'busy', 'private')),
	CONSTRAINT "calendar_events_status_check" CHECK ("status" IN ('confirmed', 'tentative', 'cancelled')),
	CONSTRAINT "calendar_events_source_check" CHECK ("source" IN ('local', 'google', 'microsoft', 'email_proposal')),
	CONSTRAINT "calendar_events_override_check" CHECK (("recurrence_id" IS NULL) = ("original_start" IS NULL)),
	CONSTRAINT "calendar_events_override_rrule_check" CHECK ("recurrence_id" IS NULL OR "rrule" IS NULL)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_events_owner_start_idx" ON "calendar_events" ("owner_id", "starts_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_events_recurrence_idx" ON "calendar_events" ("recurrence_id") WHERE "recurrence_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_events_override_uniq" ON "calendar_events" ("recurrence_id", "original_start") WHERE "recurrence_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_events_external_uniq" ON "calendar_events" ("owner_id", "source", "external_id") WHERE "external_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_attendees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL REFERENCES "calendar_events"("id") ON DELETE CASCADE,
	"member_id" text,
	"email" text,
	"name" text,
	"role" text DEFAULT 'required' NOT NULL,
	"rsvp" text DEFAULT 'needs_action' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_attendees_who_check" CHECK (("member_id" IS NULL) <> ("email" IS NULL)),
	CONSTRAINT "calendar_attendees_email_check" CHECK ("email" IS NULL OR (length("email") BETWEEN 3 AND 320 AND "email" = lower("email"))),
	CONSTRAINT "calendar_attendees_name_check" CHECK ("name" IS NULL OR length(btrim("name")) BETWEEN 1 AND 200),
	CONSTRAINT "calendar_attendees_role_check" CHECK ("role" IN ('required', 'optional')),
	CONSTRAINT "calendar_attendees_rsvp_check" CHECK ("rsvp" IN ('needs_action', 'accepted', 'declined', 'tentative'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_attendees_member_uniq" ON "calendar_attendees" ("event_id", "member_id") WHERE "member_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_attendees_email_uniq" ON "calendar_attendees" ("event_id", "email") WHERE "email" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_attendees_member_idx" ON "calendar_attendees" ("member_id") WHERE "member_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_preferences" (
	"member_id" text PRIMARY KEY NOT NULL,
	"default_visibility" text DEFAULT 'busy' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_preferences_visibility_check" CHECK ("default_visibility" IN ('company', 'busy', 'private'))
);
