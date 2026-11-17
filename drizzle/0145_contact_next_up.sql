-- Contacts "Next up" (Contribute 057ebd74, Ony: "the AI suggests the next
-- 5–10 contacts I should write to or reply to"): the assistant's last pick
-- per person, cached so the Contacts page doesn't ask the AI on every visit.
-- One row per person: the day it was made for (a new day is a new pick), when,
-- and the picks ([{ contactId, kind, reason }], validated by the service).
-- Regenerated after a few hours or on "Suggest again"; a cache, so nothing
-- else references it.

CREATE TABLE IF NOT EXISTS "contact_next_up" (
  "user_id" text PRIMARY KEY NOT NULL,
  "day" date NOT NULL,
  "generated_at" timestamp with time zone NOT NULL,
  "suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL
);
