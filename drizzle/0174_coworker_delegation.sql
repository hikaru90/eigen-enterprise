-- AI Co-workers: a limit on co-worker → co-worker task chains (plan/phase-ai-coworkers.md §6).
-- Every run records the co-workers that handed its work down, in order, the origin
-- person excluded; an assignment that would pass 3 co-workers or loop is refused
-- before the task exists (src/lib/server/coworkers/delegation.ts).
ALTER TABLE "coworker_run" ADD COLUMN IF NOT EXISTS "delegation_chain" text[] NOT NULL DEFAULT '{}'::text[];
