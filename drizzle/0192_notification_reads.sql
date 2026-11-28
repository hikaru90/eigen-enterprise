-- The notification inbox's "read" (wishes f3fc516e, 3c1481b9): which items of
-- a person's inbox (the top bar's bell, notifications.inbox) they have seen.
-- An item key is the source and the moment it changed (question:<id>,
-- task:<id>:<at>, coworker:<run id>), so news is unread again. Company-level
-- table (no RLS), like team questions: the service only ever reads and writes
-- the signed-in person's own rows.
CREATE TABLE IF NOT EXISTS "notification_reads" (
	"user_id" text NOT NULL,
	"item_key" text NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_reads_pk" PRIMARY KEY ("user_id", "item_key")
);
