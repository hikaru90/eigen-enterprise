-- Messages core (plan/phase-workspace.md C1): team chat between members.
-- One conversation table for channels and DMs; DMs are deduped by their sorted
-- member set (dm_key). Channel access goes through the access contract (§2);
-- DM access is membership (message_conversation_members). message_events is the
-- durable feed behind the SSE stream: every change appends one row and
-- pg_notify('ee_messages', id) wakes every app process (both blue-green slots);
-- a reconnecting client catches up from Last-Event-ID.

CREATE TABLE IF NOT EXISTS "message_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"topic" text DEFAULT '' NOT NULL,
	"private" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"dm_key" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_conversations_kind_check" CHECK ("kind" IN ('channel', 'dm')),
	CONSTRAINT "message_conversations_dm_key_unique" UNIQUE("dm_key"),
	CONSTRAINT "message_conversations_shape_check" CHECK (
		("kind" = 'channel' AND "name" IS NOT NULL AND "dm_key" IS NULL)
		OR ("kind" = 'dm' AND "dm_key" IS NOT NULL AND "private" = true)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "message_conversations_channel_name_idx" ON "message_conversations" (lower("name")) WHERE "kind" = 'channel';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_conversation_members" (
	"conversation_id" uuid NOT NULL REFERENCES "message_conversations"("id") ON DELETE CASCADE,
	"user_id" text NOT NULL,
	"last_read_at" timestamp with time zone,
	"viewing_at" timestamp with time zone,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_conversation_members_pk" PRIMARY KEY("conversation_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_conversation_members_user_idx" ON "message_conversation_members" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL REFERENCES "message_conversations"("id") ON DELETE CASCADE,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"parent_id" uuid REFERENCES "messages"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_conversation_created_idx" ON "messages" ("conversation_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"conversation_id" uuid NOT NULL REFERENCES "message_conversations"("id") ON DELETE CASCADE,
	"message_id" uuid,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_events_kind_check" CHECK ("kind" IN ('message.created', 'message.edited', 'message.deleted', 'conversation.created', 'conversation.read'))
);
