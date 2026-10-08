-- Phase-2e: the name the user gives during the boot sequence ("What should I call
-- you?"). NULL = never asked / skipped — the greeting stays "Hello." and the ask
-- returns next onboarding. Identity is NOT tour state: restarting onboarding keeps it.

ALTER TABLE user_preference
  ADD COLUMN display_name text;
