-- Messages depth (plan/phase-workspace.md C2): threads, reactions, attachments
-- in the Drive, and a gap-free event feed.
-- * Threads use messages.parent_id (0108); the index serves reply counts and
--   the thread panel.
-- * message_reactions: one row per (message, person, emoji) — toggling is
--   insert/delete.
-- * message_attachments: the Drive files a message carries (a snapshot of
--   name/mime/size for display; the bytes and access stay in the Drive).
-- * message_drive_folders: the Drive folder each conversation's attachments
--   land in ('root' = the shared "Messages" parent folder).
-- * message_events gains 'message.reacted'. Event ids are allocated under a
--   transaction-scoped advisory lock (db-store.ts), so ids commit in order and
--   catch-up from Last-Event-ID can never skip a late-committing event.
CREATE INDEX IF NOT EXISTS "messages_parent_created_idx" ON "messages" ("parent_id", "created_at") WHERE "parent_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_reactions" (
	"message_id" uuid NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE,
	"user_id" text NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_reactions_pk" PRIMARY KEY("message_id", "user_id", "emoji"),
	CONSTRAINT "message_reactions_emoji_check" CHECK (char_length("emoji") BETWEEN 1 AND 16)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_attachments" (
	"message_id" uuid NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE,
	"file_id" text NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" bigint NOT NULL CHECK ("size" >= 0),
	CONSTRAINT "message_attachments_pk" PRIMARY KEY("message_id", "file_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_drive_folders" (
	"scope" text PRIMARY KEY NOT NULL,
	"folder_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_events" DROP CONSTRAINT IF EXISTS "message_events_kind_check";
--> statement-breakpoint
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_kind_check" CHECK ("kind" IN ('message.created', 'message.edited', 'message.deleted', 'message.reacted', 'conversation.created', 'conversation.read'));
