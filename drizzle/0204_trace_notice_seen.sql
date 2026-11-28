-- The owner saw the one-time "Needs you" notice about product signals (plan/traces-phone-home.md §4).
-- Null until then, so new and upgraded installs get it once.
ALTER TABLE "trace_share_settings" ADD COLUMN IF NOT EXISTS "notice_seen_at" timestamp with time zone;
