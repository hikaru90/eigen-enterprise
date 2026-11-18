-- Quoted replies (Contribute 2a58bcc8, WhatsApp-style "Reply"): a message may
-- quote one earlier message of the same conversation. The service refuses an
-- original from another conversation; the column only records which message
-- was quoted. Messages are soft-deleted, so the original row stays and the
-- quote reads "Original message deleted"; a hard delete (only by the
-- conversation's cascade) clears the link.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "reply_to_id" uuid;
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_reply_to_id_fk";
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "messages"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_reply_to_id_idx" ON "messages" ("reply_to_id") WHERE "reply_to_id" IS NOT NULL;
