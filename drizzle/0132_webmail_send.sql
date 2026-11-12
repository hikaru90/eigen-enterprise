-- Webmail sending (plan/email-inbox.md S5).
--
-- The sender's own copy in Sent keeps its Bcc recipients (received mail never
-- has any: a Bcc is not in the headers the recipient gets).
ALTER TABLE "inbox_messages" ADD COLUMN IF NOT EXISTS "bcc" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
-- The fake mail transport (MAIL_TRANSPORT=fake, test servers only) captures the
-- webmail's raw MIME sends: the mail exactly as it would go to Amazon SES, and
-- every envelope recipient (Bcc included). Simple sends leave both null;
-- to_address stays the first recipient.
ALTER TABLE "mail_fake_sent" ADD COLUMN IF NOT EXISTS "raw" text;
--> statement-breakpoint
ALTER TABLE "mail_fake_sent" ADD COLUMN IF NOT EXISTS "recipients" jsonb;
