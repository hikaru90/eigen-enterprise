-- Drive edit locks (plan/phase-workspace.md D2, W-6): one editor session at a
-- time per Markdown/CSV file. The holder heartbeats; a stale heartbeat frees
-- the lock; a takeover overwrites it. Deleting the file drops its lock.
CREATE TABLE IF NOT EXISTS "drive_edit_lock" (
	"file_id" text PRIMARY KEY NOT NULL REFERENCES "drive_file"("id") ON DELETE CASCADE,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL
);
