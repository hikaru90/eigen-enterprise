-- Memory's documents become Drive files (wish f3fc516e, owner 2026-11-28: "documents should be in drive").
-- A document's text now lives in Drive (a Markdown file in its owner's My drive, its sharing = Drive
-- grants). The brain keeps an index row per document: owner, authorship, the shared/private switch and
-- the lexical text it searches. text_file and thought_text_file stay (expand; a later contract drops them).
--
-- The copy of the existing text files cannot be SQL: their bodies are sealed with the tenant key and
-- Drive keeps bytes on disk. It runs at server start (src/lib/server/text-files/drive-backfill.ts),
-- once per text file (text_file_id below is unique), and copies the thought links with it.
CREATE TABLE IF NOT EXISTS "memory_document" (
  "drive_file_id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "text_file_id" uuid UNIQUE,
  "title" text NOT NULL DEFAULT '',
  "lexical_text" text NOT NULL DEFAULT '',
  "lexical_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(lexical_text, ''))) STORED,
  "author" text NOT NULL DEFAULT 'user',
  "author_label" text,
  "author_key_id" uuid REFERENCES "user_api_key"("id") ON DELETE SET NULL,
  "visibility" text NOT NULL DEFAULT 'company',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_document_user_updated_idx" ON "memory_document" ("user_id", "updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_document_visibility_updated_idx" ON "memory_document" ("visibility", "updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_document_lexical_tsv_idx" ON "memory_document" USING gin ("lexical_tsv");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "thought_memory_document" (
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "thought_id" uuid NOT NULL REFERENCES "thought"("id") ON DELETE CASCADE,
  "drive_file_id" text NOT NULL REFERENCES "memory_document"("drive_file_id") ON DELETE CASCADE,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "thought_memory_document_pk" PRIMARY KEY ("thought_id", "drive_file_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "thought_memory_document_user_idx" ON "thought_memory_document" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "thought_memory_document_file_idx" ON "thought_memory_document" ("drive_file_id");
--> statement-breakpoint
-- The same rules as text_file (enable_rls.sql; keep identical): the owner's own rows, plus every
-- signed-in member reads the shared ones; a private document is its owner's alone.
ALTER TABLE "memory_document" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "memory_document" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS memory_document_isolation ON memory_document;
--> statement-breakpoint
CREATE POLICY memory_document_isolation ON memory_document
  FOR ALL
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));
--> statement-breakpoint
DROP POLICY IF EXISTS memory_document_shared_read ON memory_document;
--> statement-breakpoint
CREATE POLICY memory_document_shared_read ON memory_document
  FOR SELECT
  USING (
    coalesce(current_setting('app.current_user_id', true), '') <> ''
    AND visibility = 'company'
  );
--> statement-breakpoint
ALTER TABLE "thought_memory_document" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "thought_memory_document" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS thought_memory_document_isolation ON thought_memory_document;
--> statement-breakpoint
CREATE POLICY thought_memory_document_isolation ON thought_memory_document
  FOR ALL
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));
