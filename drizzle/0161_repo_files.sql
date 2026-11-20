-- GitHub repos in Drive: the full repo mirror (plan/github-drive-full-mirror.md
-- §3). Every file of the default branch is copied, not only the Markdown docs.
--
-- The per-path blob shas leave `repo_sources.doc_shas` (one jsonb row is no
-- home for 50,000 paths) and become one `repo_source_files` row per copied
-- path, keyed (source_id, path). The table cascades with its repo_sources row,
-- like repo_sources itself does with repo_source_tokens.
--
-- Existing sources arrive with an empty repo_source_files table, so their next
-- sync is a first sync (the tarball path) and copies the whole tree. The old
-- `Docs/` Drive items vanish through the normal reconcile.
--
-- `copy_mode` is the per-repo choice from §1: 'all' (every file; the default
-- for new and existing repos) or 'docs' (today's Markdown-only behaviour, for
-- huge monorepos).
CREATE TABLE IF NOT EXISTS "repo_source_files" (
	"source_id" uuid NOT NULL REFERENCES "repo_sources"("id") ON DELETE CASCADE,
	"path" text NOT NULL,
	"sha" text NOT NULL,
	"size" bigint NOT NULL,
	CONSTRAINT "repo_source_files_source_id_path_pk" PRIMARY KEY ("source_id", "path")
);
--> statement-breakpoint
ALTER TABLE "repo_sources" ADD COLUMN IF NOT EXISTS "copy_mode" text DEFAULT 'all' NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "repo_sources" ADD CONSTRAINT "repo_sources_copy_mode_check" CHECK ("copy_mode" IN ('all', 'docs'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "repo_sources" DROP COLUMN IF EXISTS "doc_shas";
