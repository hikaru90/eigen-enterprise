-- Contribute 9ae58a4e: each member may show ISO week numbers in their calendar (off by default).
ALTER TABLE "calendar_preferences" ADD COLUMN IF NOT EXISTS "show_week_numbers" boolean DEFAULT false NOT NULL;
