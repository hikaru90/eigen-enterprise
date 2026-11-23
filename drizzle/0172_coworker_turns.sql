-- AI Co-workers C3: the co-worker turn in Messages (plan/phase-ai-coworkers.md §6).
--
-- coworker_run becomes the turn queue as well as the run log. A turn is queued
-- once per (co-worker, triggering message): every app process hears the same
-- message (LISTEN ee_messages), and the unique index lets exactly one insert
-- win. A process then claims the oldest queued turn of a co-worker in a thread
-- (conversation + thread root; a DM's main log has no root) while none of that
-- co-worker's turns runs there, so turns of one co-worker in one thread run one
-- at a time, in the order they were triggered. A running turn beats a
-- heartbeat; one whose heartbeat stopped (its process died) is recovered as
-- failed ('interrupted').
--
-- stop_reason says why a turn did not answer (closed set, NULL for a done turn):
-- thread_budget (too many co-worker turns without a person), daily_cap (its
-- daily AI budget), model_error, post_error, turn_error (the turn could not be
-- prepared or recorded), interrupted, unavailable (switched off or removed
-- before the turn ran).
ALTER TABLE "coworker_run" ADD COLUMN IF NOT EXISTS "trigger_message_id" uuid REFERENCES "messages"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "coworker_run" ADD COLUMN IF NOT EXISTS "triggered_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "coworker_run" ADD COLUMN IF NOT EXISTS "heartbeat_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "coworker_run" ADD COLUMN IF NOT EXISTS "stop_reason" text;
--> statement-breakpoint
ALTER TABLE "coworker_run" ALTER COLUMN "started_at" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "coworker_run" ALTER COLUMN "started_at" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "coworker_run" ALTER COLUMN "status" SET DEFAULT 'queued';
--> statement-breakpoint
ALTER TABLE "coworker_run" DROP CONSTRAINT IF EXISTS "coworker_run_status_check";
--> statement-breakpoint
ALTER TABLE "coworker_run" ADD CONSTRAINT "coworker_run_status_check" CHECK ("status" IN ('queued', 'running', 'done', 'failed', 'stopped'));
--> statement-breakpoint
ALTER TABLE "coworker_run" DROP CONSTRAINT IF EXISTS "coworker_run_stop_reason_check";
--> statement-breakpoint
ALTER TABLE "coworker_run" ADD CONSTRAINT "coworker_run_stop_reason_check" CHECK ("stop_reason" IS NULL OR "stop_reason" IN ('thread_budget', 'daily_cap', 'model_error', 'post_error', 'turn_error', 'interrupted', 'unavailable'));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "coworker_run_trigger_message_unique" ON "coworker_run" ("coworker_user_id", "trigger_message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coworker_run_thread_idx" ON "coworker_run" ("conversation_id", "thread_root_id", "triggered_at");
