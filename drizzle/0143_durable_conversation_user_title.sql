-- A conversation's own name, set by the member who owns it (Contribute 495e40bb:
-- "rename a chat in the history"). NULL means "no name given": the list then
-- derives one at read time (first message / member / task). Auto titles are
-- never stored here, so nothing automatic can overwrite a name a member chose.
ALTER TABLE "durable_conversations" ADD COLUMN "user_title" text;
