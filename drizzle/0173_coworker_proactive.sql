-- AI Co-workers C6: co-workers act on their own (plan/phase-ai-coworkers.md §2 "proactive too", §8 C6).
--
-- coworker_rhythm: a co-worker's scheduled check-in — fixed weekdays at a wall
-- time in a time zone (the reminders' rhythm, 0163) — with what to do
-- (instruction) and where to post it (target_conversation_id, a conversation
-- the co-worker is a member of). last_slot_at is the slot the rhythm handled
-- last: a tick takes the latest due slot after it by moving it forward with a
-- compare-and-set, so exactly one app process queues that slot's run.
--
-- coworker_run gains the proactive triggers: rhythm_id (which rhythm), task_id
-- (the assigned task a run works on) and trigger_key, unique per co-worker —
-- 'rhythm:<id>:<slot>', 'task:<id>' for the assignment, 'task-comment:<id>'
-- for a person's follow-up comment — so every app process's insert but one is
-- a no-op. New stop reasons: not_member (the rhythm's conversation no longer
-- has the co-worker in it) and task_unavailable (the task is done or gone).
--
-- coworker_run_notice: a finished or stopped rhythm/assignment run in the
-- "Needs you" of the people it is for (the accountable human; for an
-- assignment also the assigner) until they acknowledge it (seen_at).
--
-- Company-level tables without RLS (like coworker_run): the coworkers.* tools
-- decide who reads and changes what.
CREATE TABLE IF NOT EXISTS "coworker_rhythm" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "coworker_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "weekdays" text[] NOT NULL,
  "local_time" text NOT NULL,
  "time_zone" text NOT NULL,
  "instruction" text NOT NULL,
  "target_conversation_id" uuid NOT NULL REFERENCES "message_conversations"("id") ON DELETE CASCADE,
  "enabled" boolean DEFAULT true NOT NULL,
  "last_slot_at" timestamp with time zone NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "coworker_rhythm_weekdays_check" CHECK (
    cardinality("weekdays") BETWEEN 1 AND 7
    AND "weekdays" <@ ARRAY['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']::text[]
  ),
  CONSTRAINT "coworker_rhythm_time_check" CHECK ("local_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT "coworker_rhythm_instruction_check" CHECK (length(btrim("instruction")) BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coworker_rhythm_coworker_idx" ON "coworker_rhythm" ("coworker_user_id", "created_at");
--> statement-breakpoint
ALTER TABLE "coworker_run" ADD COLUMN IF NOT EXISTS "rhythm_id" uuid REFERENCES "coworker_rhythm"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "coworker_run" ADD COLUMN IF NOT EXISTS "task_id" uuid REFERENCES "assigned_tasks"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "coworker_run" ADD COLUMN IF NOT EXISTS "trigger_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "coworker_run_trigger_key_unique" ON "coworker_run" ("coworker_user_id", "trigger_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coworker_run_task_idx" ON "coworker_run" ("task_id", "triggered_at");
--> statement-breakpoint
ALTER TABLE "coworker_run" DROP CONSTRAINT IF EXISTS "coworker_run_stop_reason_check";
--> statement-breakpoint
ALTER TABLE "coworker_run" ADD CONSTRAINT "coworker_run_stop_reason_check" CHECK ("stop_reason" IS NULL OR "stop_reason" IN ('thread_budget', 'daily_cap', 'model_error', 'post_error', 'turn_error', 'interrupted', 'unavailable', 'not_member', 'task_unavailable'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "coworker_run_notice" (
  "run_id" uuid NOT NULL REFERENCES "coworker_run"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "seen_at" timestamp with time zone,
  CONSTRAINT "coworker_run_notice_pk" PRIMARY KEY ("run_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coworker_run_notice_open_idx" ON "coworker_run_notice" ("user_id", "created_at") WHERE "seen_at" IS NULL;
