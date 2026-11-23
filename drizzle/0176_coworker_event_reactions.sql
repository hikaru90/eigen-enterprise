-- AI Co-workers C7: co-workers notice company events without being @mentioned
-- (plan/phase-ai-coworkers.md §2 "proactive too", §8 C7).
--
-- coworker_event_subscription: the event kinds an admin switched on for a
-- co-worker, from a closed set (today: channel_message — a new message in a
-- channel the co-worker is a member of that does not @mention it and is not
-- by a co-worker). No row = off.
--
-- coworker_event_observation: one row per (co-worker, event kind, event id),
-- whichever app process heard the event first (the unique index): the claim
-- that makes "one decision per co-worker per event" hold across processes,
-- and the counted, visible outcome of each event the co-worker heard —
-- observed (a shadow decision in decision_log), queued (an enforced "yes"
-- queued an 'event' run), skipped_rate_limit (over the hourly limit),
-- skipped_daily_cap (its daily AI budget was spent), failed, or claimed
-- (in progress). Whether an event is the co-worker's is a Jev decision of
-- kind coworkers.event_mine (decision_log, 0175); this table never holds
-- the event's content, only where it happened.
--
-- Company-level tables without RLS (like coworker_run): the coworkers.* tools
-- decide who reads and changes what.
CREATE TABLE IF NOT EXISTS "coworker_event_subscription" (
  "coworker_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "event_kind" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "coworker_event_subscription_pk" PRIMARY KEY ("coworker_user_id", "event_kind"),
  CONSTRAINT "coworker_event_subscription_kind_check" CHECK ("event_kind" IN ('channel_message'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "coworker_event_observation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "coworker_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "event_kind" text NOT NULL,
  "event_id" text NOT NULL,
  "conversation_id" uuid REFERENCES "message_conversations"("id") ON DELETE SET NULL,
  "outcome" text NOT NULL,
  "decision_id" uuid REFERENCES "decision_log"("id") ON DELETE SET NULL,
  "run_id" uuid REFERENCES "coworker_run"("id") ON DELETE SET NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "coworker_event_observation_kind_check" CHECK ("event_kind" IN ('channel_message')),
  CONSTRAINT "coworker_event_observation_outcome_check" CHECK ("outcome" IN ('claimed', 'observed', 'queued', 'skipped_rate_limit', 'skipped_daily_cap', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "coworker_event_observation_event_unique" ON "coworker_event_observation" ("coworker_user_id", "event_kind", "event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coworker_event_observation_recent_idx" ON "coworker_event_observation" ("coworker_user_id", "created_at");
