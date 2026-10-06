-- Phase-1e: welcome setup wizard completion flag (per user).
-- NULL = the user has not been through the welcome tour on `/` — the wizard shows.
-- Timestamp = the user completed (or skipped) it; the tour never nags again.
-- Deliberately separate from user.onboarding_completed, which means "provider
-- onboarding done" and is only set by the provider save path.

ALTER TABLE user_preference
  ADD COLUMN welcome_completed_at timestamp;
