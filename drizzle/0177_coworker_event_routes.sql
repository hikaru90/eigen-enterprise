-- AI Co-workers C7, routed once (owner decision 2026-11-24, plan/phase-ai-coworkers.md §8 C7):
-- the company's assistant reads each channel message ONCE and routes it to the
-- co-workers it belongs to — one Jev call per message (one yes/no question per
-- candidate co-worker), not one per co-worker.
--
-- coworker_event_route: one row per (event kind, event id), whichever app process
-- heard the message first (the unique index) — the claim that makes "one routing
-- call per message" hold across processes and redeliveries. Its outcome:
-- claimed (in progress), decided (the one call was made), skipped_author_cap
-- (the call is billed to the message's author and their member daily AI cap was
-- spent), skipped_daily_cap (every candidate co-worker's own daily cap was spent:
-- nothing to ask), failed. candidates = co-workers the message could be for;
-- questions = how many were asked in the call.
--
-- coworker_event_observation keeps one row per co-worker and message (route_id
-- links it to its route; NULL for rows made before routing). New outcome
-- skipped_author_cap. skipped_rate_limit stays allowed for the rows made while
-- the per-co-worker hourly limit existed; it is no longer produced (the limit
-- was removed with this change).
CREATE TABLE IF NOT EXISTS "coworker_event_route" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_kind" text NOT NULL,
  "event_id" text NOT NULL,
  "conversation_id" uuid REFERENCES "message_conversations"("id") ON DELETE SET NULL,
  "author_user_id" text NOT NULL,
  "outcome" text NOT NULL,
  "candidates" integer NOT NULL,
  "questions" integer DEFAULT 0 NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "coworker_event_route_kind_check" CHECK ("event_kind" IN ('channel_message')),
  CONSTRAINT "coworker_event_route_outcome_check" CHECK ("outcome" IN ('claimed', 'decided', 'skipped_author_cap', 'skipped_daily_cap', 'failed')),
  CONSTRAINT "coworker_event_route_counts_check" CHECK ("candidates" >= 1 AND "questions" >= 0 AND "questions" <= "candidates")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "coworker_event_route_event_unique" ON "coworker_event_route" ("event_kind", "event_id");
--> statement-breakpoint
ALTER TABLE "coworker_event_observation" ADD COLUMN IF NOT EXISTS "route_id" uuid REFERENCES "coworker_event_route"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "coworker_event_observation" DROP CONSTRAINT IF EXISTS "coworker_event_observation_outcome_check";
--> statement-breakpoint
ALTER TABLE "coworker_event_observation" ADD CONSTRAINT "coworker_event_observation_outcome_check" CHECK ("outcome" IN ('claimed', 'observed', 'queued', 'skipped_rate_limit', 'skipped_daily_cap', 'skipped_author_cap', 'failed'));
