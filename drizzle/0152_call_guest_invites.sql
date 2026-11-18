-- Call guests (Contribute proposal 844bab56): people outside the company join a
-- meeting from a personal browser link — no account, no install. A meeting
-- with a schedule ("windowed") is open for joining from its start until its
-- scheduled end plus a grace period (modules/calls/guests.ts) instead of
-- ringing for 45 seconds; it may instead point at another provider's call
-- link (Zoom, Teams, Google Meet …), then it has no LiveKit room.
-- A guest's link token is never stored: only its SHA-256.
ALTER TABLE "call" ADD COLUMN IF NOT EXISTS "scheduled_start" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN IF NOT EXISTS "scheduled_end" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN IF NOT EXISTS "external_url" text;
--> statement-breakpoint
ALTER TABLE "call" DROP CONSTRAINT IF EXISTS "call_state_check";
--> statement-breakpoint
ALTER TABLE "call" ADD CONSTRAINT "call_state_check" CHECK ("state" IN ('scheduled', 'ringing', 'active', 'ended', 'missed', 'declined'));
--> statement-breakpoint
ALTER TABLE "call" DROP CONSTRAINT IF EXISTS "call_ended_check";
--> statement-breakpoint
ALTER TABLE "call" ADD CONSTRAINT "call_ended_check" CHECK (("state" IN ('scheduled', 'ringing', 'active')) = ("ended_at" IS NULL));
--> statement-breakpoint
ALTER TABLE "call" DROP CONSTRAINT IF EXISTS "call_schedule_check";
--> statement-breakpoint
ALTER TABLE "call" ADD CONSTRAINT "call_schedule_check" CHECK (
	("scheduled_start" IS NULL) = ("scheduled_end" IS NULL)
	AND ("scheduled_end" IS NULL OR ("scheduled_end" > "scheduled_start" AND "context_kind" = 'meeting'))
	AND ("state" <> 'scheduled' OR "scheduled_end" IS NOT NULL)
	AND ("external_url" IS NULL OR ("scheduled_end" IS NOT NULL AND length("external_url") BETWEEN 1 AND 2000))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_window_end_idx" ON "call" ("scheduled_end") WHERE "state" IN ('scheduled', 'active') AND "scheduled_end" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "call_guest" (
	"id" uuid PRIMARY KEY NOT NULL,
	"call_id" uuid NOT NULL REFERENCES "call"("id") ON DELETE CASCADE,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" text NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"display_name" text,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "call_guest_token_hash_unique" UNIQUE ("token_hash"),
	CONSTRAINT "call_guest_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "call_guest_display_name_check" CHECK ("display_name" IS NULL OR length("display_name") BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_guest_call_idx" ON "call_guest" ("call_id", "invited_at");
