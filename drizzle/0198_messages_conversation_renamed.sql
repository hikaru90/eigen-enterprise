-- Group chats get names (wish 2734a371): a rename is a message event, so every member's stream updates the title.
ALTER TABLE "message_events" DROP CONSTRAINT IF EXISTS "message_events_kind_check";
--> statement-breakpoint
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_kind_check" CHECK ("kind" IN ('message.created', 'message.edited', 'message.deleted', 'message.reacted', 'conversation.created', 'conversation.read', 'conversation.renamed'));
