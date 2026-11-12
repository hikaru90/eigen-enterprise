-- Drive archive (plan/contribute-round-3.md W4): archiving is a state on a
-- file or folder, not a magic folder. An archived item stays where it is and
-- keeps its sharing; it leaves the normal views and shows in Archived, still
-- openable and found by search. archived_by is who archived it (a member id,
-- or the agent's principal id). Unarchiving clears both.
ALTER TABLE "drive_folder" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "drive_folder" ADD COLUMN IF NOT EXISTS "archived_by" text;
--> statement-breakpoint
ALTER TABLE "drive_file" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "drive_file" ADD COLUMN IF NOT EXISTS "archived_by" text;
--> statement-breakpoint
ALTER TABLE "drive_folder" DROP CONSTRAINT IF EXISTS "drive_folder_archived_pair_check";
--> statement-breakpoint
ALTER TABLE "drive_folder" ADD CONSTRAINT "drive_folder_archived_pair_check" CHECK (("archived_at" IS NULL) = ("archived_by" IS NULL));
--> statement-breakpoint
ALTER TABLE "drive_file" DROP CONSTRAINT IF EXISTS "drive_file_archived_pair_check";
--> statement-breakpoint
ALTER TABLE "drive_file" ADD CONSTRAINT "drive_file_archived_pair_check" CHECK (("archived_at" IS NULL) = ("archived_by" IS NULL));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_folder_archived_idx" ON "drive_folder" ("archived_at") WHERE "archived_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drive_file_archived_idx" ON "drive_file" ("archived_at") WHERE "archived_at" IS NOT NULL;
--> statement-breakpoint
-- "Suggest what to archive" picks live files unchanged since a cut-off, oldest first.
CREATE INDEX IF NOT EXISTS "drive_file_live_updated_idx" ON "drive_file" ("updated_at") WHERE "trashed_at" IS NULL AND "archived_at" IS NULL;
