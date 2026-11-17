-- Pick your tiles (Contribute 06894ad7): the dashboard tiles a person closed with
-- their ×, kept per user so they stay hidden on every device. Empty = all shown.
ALTER TABLE "user_preference" ADD COLUMN "dashboard_hidden_tiles" jsonb DEFAULT '[]'::jsonb NOT NULL;
