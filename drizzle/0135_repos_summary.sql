-- GitHub repos in Drive S4 (plan/github-drive.md §6): the assistant's "What's
-- going on" per repo. Written by one gateway call after a sync that found
-- changes. `summary` keeps the last good one ({summary, highlights,
-- writtenAt}); `summary_error_kind` says why the latest attempt wrote none
-- (no model selected, or the call failed) and then the kept summary is stale.
ALTER TABLE "repo_sources" ADD COLUMN IF NOT EXISTS "summary" jsonb;
--> statement-breakpoint
ALTER TABLE "repo_sources" ADD COLUMN IF NOT EXISTS "summary_error_kind" text;
--> statement-breakpoint
ALTER TABLE "repo_sources" ADD COLUMN IF NOT EXISTS "summary_error" text;
--> statement-breakpoint
ALTER TABLE "repo_sources" ADD COLUMN IF NOT EXISTS "summary_error_at" timestamp with time zone;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "repo_sources" ADD CONSTRAINT "repo_sources_summary_error_kind_check" CHECK ("summary_error_kind" IS NULL OR "summary_error_kind" IN ('no_model', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
