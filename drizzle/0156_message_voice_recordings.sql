-- Voice messages keep their recording (Contribute: play voice messages back, not only
-- their transcript). A message attachment with a length is the dictated clip itself,
-- played above the transcript; NULL for every ordinary file (and for all rows before this).
ALTER TABLE "message_attachments" ADD COLUMN IF NOT EXISTS "voice_duration_ms" integer;
