-- Chat in a call (proposal bb05b451, "we still need a chat function in the
-- call"): people in a call — members and guests invited by link — write text
-- to each other while it goes on. One table for every call (DM, channel and
-- meeting), owned by Calls: a guest has no account, so Messages (whose
-- authors are accounts) cannot hold their lines. The chat stays after the
-- call; it is read on the call's transcript page and merged into what the
-- Company Brain reads, marked as chat. Company-level table (no RLS), like
-- call: access is decided in the calls service (modules/calls/service.ts).
-- Every insert wakes the console processes (pg_notify('ee_calls_chat', seq)).

CREATE TABLE IF NOT EXISTS "call_chat_message" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"call_id" uuid NOT NULL REFERENCES "call"("id") ON DELETE CASCADE,
	"author_id" text NOT NULL,
	"author_kind" text NOT NULL,
	"author_name" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_chat_message_kind_check" CHECK ("author_kind" IN ('member', 'guest')),
	CONSTRAINT "call_chat_message_name_check" CHECK (length("author_name") BETWEEN 1 AND 200),
	CONSTRAINT "call_chat_message_body_check" CHECK (length("body") BETWEEN 1 AND 4000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_chat_message_call_idx" ON "call_chat_message" ("call_id", "seq");
