-- P-4 (plan/phase-polish-1.md): the roadmap becomes a Memory project.
--
-- The roadmap is the system project "Roadmap" in the company owner's Memory
-- (canonical_entity.system_key = 'roadmap'); its items are that project's
-- tasks (thought rows, category 'task', linked through thought_entity).
-- The roadmap vocabulary maps onto the Memory task model:
--   planned     = lifecycle open,      task_started_at NULL
--   in_progress = lifecycle open,      task_started_at set
--   shipped     = lifecycle completed, lifecycle_completed_at = shipped at
--   kind        = task_kind (feature | fix | chore)
--   position    = task_position (order within its stage)
--   detail      = thought metadata "detail"
--
-- Memory rows belong to a user (RLS on user_id), and the company owner may not
-- exist yet when this runs (a fresh install migrates before it is claimed). So
-- the copy is one idempotent SQL function, roadmap_ensure_project(user_id):
-- this migration calls it for the owner when there is one, and the app calls
-- it (modules/orchestrator/roadmap/store.ts) every time it resolves the
-- Roadmap project — so an unclaimed install adopts the legacy rows the moment
-- its owner exists. extension_roadmap_items is dropped inside the function,
-- and only after every row is verified copied; otherwise it raises and the
-- table stays.

ALTER TABLE "canonical_entity" ADD COLUMN IF NOT EXISTS "system_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "canonical_entity_user_system_key_uidx"
	ON "canonical_entity" ("user_id", "system_key") WHERE "system_key" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "thought" ADD COLUMN IF NOT EXISTS "task_kind" text;
--> statement-breakpoint
ALTER TABLE "thought" ADD COLUMN IF NOT EXISTS "task_started_at" timestamp;
--> statement-breakpoint
ALTER TABLE "thought" ADD COLUMN IF NOT EXISTS "task_position" integer;
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'thought_task_kind_check') THEN
		ALTER TABLE "thought" ADD CONSTRAINT "thought_task_kind_check"
			CHECK ("task_kind" IS NULL OR "task_kind" IN ('feature', 'fix', 'chore'));
	END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION roadmap_ensure_project(p_user_id text) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
	v_caller text := current_setting('app.current_user_id', true);
	v_owner text;
	v_task_kind uuid;
	v_project uuid;
	v_legacy integer;
	v_copied integer;
BEGIN
	IF p_user_id IS NULL OR p_user_id = '' THEN
		RAISE EXCEPTION 'roadmap_ensure_project: a user id is required';
	END IF;
	-- An app session may only ensure its own Memory's project.
	IF v_caller IS NOT NULL AND v_caller <> '' AND v_caller <> p_user_id THEN
		RAISE EXCEPTION 'roadmap_ensure_project: session user % cannot ensure the project of %', v_caller, p_user_id;
	END IF;
	-- Memory tables FORCE row-level security on user_id: act as that user for
	-- this transaction, restored before returning.
	PERFORM set_config('app.current_user_id', p_user_id, true);

	-- Tasks need the user's 'task' thought category (seeded on first capture).
	INSERT INTO "ontology_entity_kind" ("user_id", "key", "name", "definition", "active", "kind_type")
	VALUES (p_user_id, 'task', 'Task', 'Something to do, an action item, or work in progress', true, 'thought_category')
	ON CONFLICT ("user_id", "key") DO NOTHING;
	SELECT "id" INTO v_task_kind FROM "ontology_entity_kind" WHERE "user_id" = p_user_id AND "key" = 'task';

	-- The system project. canonical_key is namespaced so entity resolution of a
	-- thought that merely mentions "roadmap" never lands on it.
	INSERT INTO "canonical_entity" ("user_id", "canonical_key", "label", "entity_type", "project_status",
		"project_source", "project_designated_at", "system_key")
	VALUES (p_user_id, 'system:roadmap', 'Roadmap', 'project', 'active', 'manual', now(), 'roadmap')
	ON CONFLICT DO NOTHING;
	SELECT "id" INTO v_project FROM "canonical_entity" WHERE "user_id" = p_user_id AND "system_key" = 'roadmap';
	IF v_project IS NULL THEN
		RAISE EXCEPTION 'roadmap_ensure_project: could not create the Roadmap project for %', p_user_id;
	END IF;

	-- Legacy rows move into the company owner's Memory only.
	SELECT "id" INTO v_owner FROM "user" WHERE "role" = 'owner' LIMIT 1;
	IF to_regclass('public.extension_roadmap_items') IS NOT NULL AND v_owner = p_user_id THEN
		EXECUTE $copy$
			INSERT INTO "thought" ("id", "user_id", "raw_text", "normalized_text", "lexical_text", "category",
				"ontology_entity_kind_id", "metadata", "capture_source", "author", "lifecycle_status",
				"lifecycle_updated_at", "lifecycle_completed_at", "task_kind", "task_started_at", "task_position",
				"created_at", "updated_at")
			SELECT r."id", $1, r."title", r."title",
				regexp_replace(btrim(lower(normalize(r."title", NFKC))), '\s+', ' ', 'g'),
				'task', $2, jsonb_build_object('detail', r."detail"), 'api', 'user',
				CASE WHEN r."status" = 'shipped' THEN 'completed' ELSE 'open' END,
				r."updated_at" AT TIME ZONE 'UTC',
				CASE WHEN r."status" = 'shipped' THEN coalesce(r."shipped_at", r."updated_at") AT TIME ZONE 'UTC' END,
				r."kind",
				CASE WHEN r."status" = 'in_progress' THEN r."updated_at" AT TIME ZONE 'UTC' END,
				r."position", r."created_at" AT TIME ZONE 'UTC', r."updated_at" AT TIME ZONE 'UTC'
			FROM "extension_roadmap_items" r
			ON CONFLICT ("id") DO NOTHING
		$copy$ USING p_user_id, v_task_kind;
		EXECUTE $link$
			INSERT INTO "thought_entity" ("thought_id", "entity_id", "user_id", "salience", "source")
			SELECT r."id", $2, $1, 1, 'manual' FROM "extension_roadmap_items" r
			JOIN "thought" t ON t."id" = r."id" AND t."user_id" = $1
			ON CONFLICT DO NOTHING
		$link$ USING p_user_id, v_project;
		EXECUTE 'SELECT count(*) FROM "extension_roadmap_items"' INTO v_legacy;
		EXECUTE $verify$
			SELECT count(*) FROM "extension_roadmap_items" r
			JOIN "thought" t ON t."id" = r."id" AND t."user_id" = $1 AND t."category" = 'task'
			JOIN "thought_entity" te ON te."thought_id" = r."id" AND te."entity_id" = $2
		$verify$ INTO v_copied USING p_user_id, v_project;
		IF v_copied <> v_legacy THEN
			RAISE EXCEPTION 'roadmap_ensure_project: copied % of % roadmap items; extension_roadmap_items kept', v_copied, v_legacy;
		END IF;
		DROP TABLE "extension_roadmap_items";
	END IF;

	PERFORM set_config('app.current_user_id', coalesce(v_caller, ''), true);
	RETURN v_project;
END
$fn$;
--> statement-breakpoint
SELECT roadmap_ensure_project("id") FROM "user" WHERE "role" = 'owner';
