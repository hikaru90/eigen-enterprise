-- Drive core (plan/phase-workspace.md D1, W-5): folders, files, Markdown/CSV
-- revisions. File bytes live on disk as sha256-named blobs under
-- $DRIVE_STORAGE_DIR (else $EE_STATE_DIR/drive); these rows are the metadata.
-- Sharing lives in the access contract's access_grant (0107), resource
-- types 'folder' / 'file' with these ids.
CREATE TABLE IF NOT EXISTS "drive_folder" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_id" text REFERENCES "drive_folder"("id") ON DELETE RESTRICT,
	"name" text NOT NULL,
	"owner_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"trashed_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_folder_parent_idx" ON "drive_folder" ("parent_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "drive_file" (
	"id" text PRIMARY KEY NOT NULL,
	"folder_id" text REFERENCES "drive_folder"("id") ON DELETE RESTRICT,
	"name" text NOT NULL,
	"owner_id" text NOT NULL,
	"mime" text NOT NULL,
	"size" bigint NOT NULL CHECK ("size" >= 0),
	"sha256" text NOT NULL CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"trashed_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_file_folder_idx" ON "drive_file" ("folder_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_file_sha_idx" ON "drive_file" ("sha256");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "drive_revision" (
	"id" text PRIMARY KEY NOT NULL,
	"file_id" text NOT NULL REFERENCES "drive_file"("id") ON DELETE CASCADE,
	"sha256" text NOT NULL CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
	"size" bigint NOT NULL CHECK ("size" >= 0),
	"author_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_revision_file_idx" ON "drive_revision" ("file_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_revision_sha_idx" ON "drive_revision" ("sha256");
