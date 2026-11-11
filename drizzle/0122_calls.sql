-- Calls (plan/video-calls.md §1): video calls for a DM, a channel or a
-- meeting, all on the company's LiveKit server. One row per call; one row per
-- person in it. The LiveKit webhook is the truth about who joined and left.
-- Company-level tables (no RLS), like messages: access is decided in the
-- calls service (the context's members via Messages, a meeting's invite list).

CREATE TABLE IF NOT EXISTS "call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_name" text NOT NULL,
	"context_kind" text NOT NULL,
	"context_id" text,
	"title" text NOT NULL,
	"started_by" text NOT NULL,
	"state" text DEFAULT 'ringing' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "call_room_name_unique" UNIQUE ("room_name"),
	CONSTRAINT "call_context_kind_check" CHECK ("context_kind" IN ('dm', 'channel', 'meeting')),
	CONSTRAINT "call_context_id_check" CHECK (("context_kind" = 'meeting') = ("context_id" IS NULL)),
	CONSTRAINT "call_title_check" CHECK (length("title") BETWEEN 1 AND 200),
	CONSTRAINT "call_state_check" CHECK ("state" IN ('ringing', 'active', 'ended', 'missed', 'declined')),
	CONSTRAINT "call_ended_check" CHECK (("state" IN ('ringing', 'active')) = ("ended_at" IS NULL))
);
--> statement-breakpoint
-- At most one live call per DM/channel: two people calling each other at once land in one call.
CREATE UNIQUE INDEX IF NOT EXISTS "call_live_context_idx" ON "call" ("context_kind", "context_id") WHERE "state" IN ('ringing', 'active') AND "context_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_state_started_idx" ON "call" ("state", "started_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_started_by_idx" ON "call" ("started_by", "started_at" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "call_participant" (
	"call_id" uuid NOT NULL REFERENCES "call"("id") ON DELETE CASCADE,
	"user_id" text NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"joined_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"response" text DEFAULT 'none' NOT NULL,
	CONSTRAINT "call_participant_pk" PRIMARY KEY ("call_id", "user_id"),
	CONSTRAINT "call_participant_response_check" CHECK ("response" IN ('accepted', 'declined', 'none'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_participant_user_idx" ON "call_participant" ("user_id", "invited_at" DESC);
