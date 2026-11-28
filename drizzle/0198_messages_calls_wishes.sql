-- Group chats get names (wish 2734a371): a rename is a message event, so every member's stream updates the title.
ALTER TABLE "message_events" DROP CONSTRAINT IF EXISTS "message_events_kind_check";
--> statement-breakpoint
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_kind_check" CHECK ("kind" IN ('message.created', 'message.edited', 'message.deleted', 'message.reacted', 'conversation.created', 'conversation.read', 'conversation.renamed'));
--> statement-breakpoint
-- A pasted image in a call's chat (wish 4fbf9991): the bytes live with the call (a guest has no Drive),
-- read only through the calls service by people who read that call's chat.
CREATE TABLE IF NOT EXISTS "call_chat_image" (
	"id" uuid PRIMARY KEY NOT NULL,
	"call_id" uuid NOT NULL REFERENCES "call"("id") ON DELETE CASCADE,
	"uploaded_by" text NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"bytes" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_chat_image_size_check" CHECK ("size" BETWEEN 1 AND 10485760),
	CONSTRAINT "call_chat_image_name_check" CHECK (length("name") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_chat_image_call_idx" ON "call_chat_image" ("call_id");
--> statement-breakpoint
ALTER TABLE "call_chat_message" ADD COLUMN IF NOT EXISTS "image_id" uuid REFERENCES "call_chat_image"("id");
--> statement-breakpoint
-- An image line may carry no text.
ALTER TABLE "call_chat_message" DROP CONSTRAINT IF EXISTS "call_chat_message_body_check";
--> statement-breakpoint
ALTER TABLE "call_chat_message" ADD CONSTRAINT "call_chat_message_body_check" CHECK (length("body") BETWEEN 1 AND 4000 OR ("image_id" IS NOT NULL AND length("body") <= 4000));
--> statement-breakpoint
-- "Make summary" on /calls (wish 397dfda6): the recap the Company Brain wrote for whoever switched it on, kept so the call row shows it.
CREATE TABLE IF NOT EXISTS "call_brain_recap" (
	"call_id" uuid NOT NULL REFERENCES "call"("id") ON DELETE CASCADE,
	"user_id" text NOT NULL,
	"recap" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_brain_recap_pk" PRIMARY KEY ("call_id", "user_id")
);
