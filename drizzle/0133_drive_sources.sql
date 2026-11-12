-- Drive source folders (plan/github-drive.md §5, S2): read-only copies a
-- source plugin (e.g. GitHub repos) writes into Drive through the system
-- writer. `source` is the plugin id; null for everything people make.
-- drive_source_items maps the source's own stable keys to Drive items, so a
-- sync upserts by key (Drive has no unique (parent, name)). content_sha is
-- the sha256 of a file's bytes (null for folders): a file is rewritten only
-- when it changed.
ALTER TABLE "drive_folder" ADD COLUMN IF NOT EXISTS "source" text;
--> statement-breakpoint
ALTER TABLE "drive_file" ADD COLUMN IF NOT EXISTS "source" text;
--> statement-breakpoint
-- One root folder per source (the top-level folder it writes under).
CREATE UNIQUE INDEX IF NOT EXISTS "drive_folder_source_root_uq" ON "drive_folder" ("source") WHERE "source" IS NOT NULL AND "parent_id" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "drive_source_items" (
  "source" text NOT NULL,
  "external_key" text NOT NULL,
  "item_id" text NOT NULL,
  "kind" text NOT NULL,
  "parent_key" text,
  "content_sha" text,
  CONSTRAINT "drive_source_items_pk" PRIMARY KEY ("source", "external_key"),
  CONSTRAINT "drive_source_items_kind_check" CHECK ("kind" IN ('folder', 'file'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "drive_source_items_item_uq" ON "drive_source_items" ("kind", "item_id");
