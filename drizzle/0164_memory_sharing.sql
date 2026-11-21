-- Shared Memory (plan/shared-memory-voice-agent-tools.md §1, owner decision 2026-11-21).
--
-- Projects (canonical_entity rows with a live project_status) and notes
-- (text_file) are shared with everyone in the company by default; each has a
-- Private switch: private = readable by its owner only, with no admin or
-- owner override. Tasks in a shared project follow the project; every other
-- thought (Capture, tasks outside projects, tasks of a private project) stays
-- private.
--
-- THIS EXPOSES EXISTING DATA: the column default below makes every existing
-- project and note shared with every member of the company the moment this
-- runs. Neither table carries any explicit private marker today (there was no
-- way to mark one), so no existing row is kept private. Announced in
-- plan/progress.md; people make an item private again with its switch.
--
-- Reads: a second, permissive FOR SELECT policy per table adds what a
-- signed-in colleague may read; the existing owner policy (FOR ALL) keeps every
-- write owner-only. The same policies live in src/lib/server/db/enable_rls.sql,
-- which ee re-applies after every migrate; the two must stay identical.
--
-- Keys: shared rows are encrypted with the company key (company_data_key,
-- below) instead of the owner's; SQL cannot encrypt, so the app re-keys
-- existing shared rows at start (src/lib/server/memory/shared-memory-keys.ts).

ALTER TABLE "canonical_entity" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'company' NOT NULL;
--> statement-breakpoint
ALTER TABLE "text_file" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'company' NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'canonical_entity_visibility_check') THEN
		ALTER TABLE "canonical_entity" ADD CONSTRAINT "canonical_entity_visibility_check"
			CHECK ("visibility" IN ('private', 'company'));
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'text_file_visibility_check') THEN
		ALTER TABLE "text_file" ADD CONSTRAINT "text_file_visibility_check"
			CHECK ("visibility" IN ('private', 'company'));
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canonical_entity_shared_project_idx" ON "canonical_entity" ("user_id")
	WHERE "visibility" = 'company' AND "project_status" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "text_file_visibility_updated_idx" ON "text_file" ("visibility", "updated_at");
--> statement-breakpoint
-- The company's data key: one row, wrapped by the server's master key like
-- tenant_data_key. Every signed-in session may read it (shared content is for
-- every member); nobody updates or deletes it through the app.
CREATE TABLE IF NOT EXISTS "company_data_key" (
	"id" text PRIMARY KEY NOT NULL DEFAULT 'company' CHECK ("id" = 'company'),
	"wrapped_dek" text NOT NULL,
	"dek_version" integer DEFAULT 1 NOT NULL,
	"kek_provider" text NOT NULL,
	"kek_key_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_data_key" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "company_data_key" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS company_data_key_read ON "company_data_key";
--> statement-breakpoint
CREATE POLICY company_data_key_read ON "company_data_key"
  FOR SELECT
  USING (coalesce(current_setting('app.current_user_id', true), '') <> '');
--> statement-breakpoint
DROP POLICY IF EXISTS company_data_key_create ON "company_data_key";
--> statement-breakpoint
CREATE POLICY company_data_key_create ON "company_data_key"
  FOR INSERT
  WITH CHECK (coalesce(current_setting('app.current_user_id', true), '') <> '');
--> statement-breakpoint
-- Projects: a live project marked 'company' is readable by every signed-in member.
DROP POLICY IF EXISTS canonical_entity_shared_read ON "canonical_entity";
--> statement-breakpoint
CREATE POLICY canonical_entity_shared_read ON "canonical_entity"
  FOR SELECT
  USING (
    coalesce(current_setting('app.current_user_id', true), '') <> ''
    AND visibility = 'company'
    AND project_status IS NOT NULL
    AND project_status <> 'dismissed'
  );
--> statement-breakpoint
-- Project links: rows pointing at a shared project (thought ids and salience only;
-- the thought itself is readable only when it is a task, below).
DROP POLICY IF EXISTS thought_entity_shared_read ON "thought_entity";
--> statement-breakpoint
CREATE POLICY thought_entity_shared_read ON "thought_entity"
  FOR SELECT
  USING (
    coalesce(current_setting('app.current_user_id', true), '') <> ''
    AND EXISTS (
      SELECT 1 FROM canonical_entity ce
      WHERE ce.id = thought_entity.entity_id
        AND ce.user_id = thought_entity.user_id
        AND ce.visibility = 'company'
        AND ce.project_status IS NOT NULL
        AND ce.project_status <> 'dismissed'
    )
  );
--> statement-breakpoint
-- A link is written by the owner of both the thought and the project.
DROP POLICY IF EXISTS thought_entity_isolation ON "thought_entity";
--> statement-breakpoint
CREATE POLICY thought_entity_isolation ON "thought_entity"
  FOR ALL
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (
    user_id = current_setting('app.current_user_id', true)
    AND EXISTS (
      SELECT 1 FROM canonical_entity ce
      WHERE ce.id = thought_entity.entity_id AND ce.user_id = thought_entity.user_id
    )
  );
--> statement-breakpoint
-- Tasks follow their project: a task thought linked to a shared project of its owner.
DROP POLICY IF EXISTS thought_shared_read ON "thought";
--> statement-breakpoint
CREATE POLICY thought_shared_read ON "thought"
  FOR SELECT
  USING (
    coalesce(current_setting('app.current_user_id', true), '') <> ''
    AND category = 'task'
    AND EXISTS (
      SELECT 1 FROM thought_entity te
      JOIN canonical_entity ce ON ce.id = te.entity_id
      WHERE te.thought_id = thought.id
        AND te.user_id = thought.user_id
        AND ce.user_id = thought.user_id
        AND ce.visibility = 'company'
        AND ce.project_status IS NOT NULL
        AND ce.project_status <> 'dismissed'
    )
  );
--> statement-breakpoint
-- Dates of those tasks: readable when the reader can read the thought.
DROP POLICY IF EXISTS temporal_event_shared_read ON "temporal_event";
--> statement-breakpoint
CREATE POLICY temporal_event_shared_read ON "temporal_event"
  FOR SELECT
  USING (
    coalesce(current_setting('app.current_user_id', true), '') <> ''
    AND thought_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM thought t
      WHERE t.id = temporal_event.thought_id AND t.user_id = temporal_event.user_id
    )
  );
--> statement-breakpoint
-- Task order and milestones had no row-level security at all; they get the
-- owner policy (writes only into the writer's own project) plus shared read.
ALTER TABLE "project_task_sequence" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "project_task_sequence" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS project_task_sequence_isolation ON "project_task_sequence";
--> statement-breakpoint
CREATE POLICY project_task_sequence_isolation ON "project_task_sequence"
  FOR ALL
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (
    user_id = current_setting('app.current_user_id', true)
    AND EXISTS (
      SELECT 1 FROM canonical_entity ce
      WHERE ce.id = project_task_sequence.project_entity_id AND ce.user_id = project_task_sequence.user_id
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS project_task_sequence_shared_read ON "project_task_sequence";
--> statement-breakpoint
CREATE POLICY project_task_sequence_shared_read ON "project_task_sequence"
  FOR SELECT
  USING (
    coalesce(current_setting('app.current_user_id', true), '') <> ''
    AND EXISTS (
      SELECT 1 FROM canonical_entity ce
      WHERE ce.id = project_task_sequence.project_entity_id
        AND ce.user_id = project_task_sequence.user_id
        AND ce.visibility = 'company'
        AND ce.project_status IS NOT NULL
        AND ce.project_status <> 'dismissed'
    )
  );
--> statement-breakpoint
ALTER TABLE "project_milestone" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "project_milestone" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS project_milestone_isolation ON "project_milestone";
--> statement-breakpoint
CREATE POLICY project_milestone_isolation ON "project_milestone"
  FOR ALL
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (
    user_id = current_setting('app.current_user_id', true)
    AND EXISTS (
      SELECT 1 FROM canonical_entity ce
      WHERE ce.id = project_milestone.project_entity_id AND ce.user_id = project_milestone.user_id
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS project_milestone_shared_read ON "project_milestone";
--> statement-breakpoint
CREATE POLICY project_milestone_shared_read ON "project_milestone"
  FOR SELECT
  USING (
    coalesce(current_setting('app.current_user_id', true), '') <> ''
    AND EXISTS (
      SELECT 1 FROM canonical_entity ce
      WHERE ce.id = project_milestone.project_entity_id
        AND ce.user_id = project_milestone.user_id
        AND ce.visibility = 'company'
        AND ce.project_status IS NOT NULL
        AND ce.project_status <> 'dismissed'
    )
  );
--> statement-breakpoint
-- Notes marked 'company' are readable by every signed-in member.
DROP POLICY IF EXISTS text_file_shared_read ON "text_file";
--> statement-breakpoint
CREATE POLICY text_file_shared_read ON "text_file"
  FOR SELECT
  USING (
    coalesce(current_setting('app.current_user_id', true), '') <> ''
    AND visibility = 'company'
  );
