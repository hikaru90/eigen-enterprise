-- Contact history (Contribute b8a87a25, "Kontaktverlauf"): every "Log a
-- contact" is kept as an entry — the day you were in touch, how it went, the
-- follow-up it answered and the one it set — so a contact's page shows a
-- timeline instead of only the latest values on "contacts". Mail exchanged
-- with the person is not copied here: the timeline reads it from the
-- mailboxes the viewer may read. Company-level table (no RLS), like
-- "contacts": an entry is visible to whoever may see its contact (decided in
-- the contacts service); it goes when the contact is deleted.

CREATE TABLE IF NOT EXISTS "contact_log_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
	"on" date NOT NULL,
	"note" text,
	"answered_follow_up_on" date,
	"answered_step" text,
	"next_follow_up_on" date,
	"next_step" text,
	"logged_by" text NOT NULL,
	"logged_by_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_log_entries_note_check" CHECK ("note" IS NULL OR length(btrim("note")) BETWEEN 1 AND 2000),
	CONSTRAINT "contact_log_entries_answered_step_check" CHECK ("answered_step" IS NULL OR length(btrim("answered_step")) BETWEEN 1 AND 500),
	CONSTRAINT "contact_log_entries_next_step_check" CHECK ("next_step" IS NULL OR length(btrim("next_step")) BETWEEN 1 AND 500),
	CONSTRAINT "contact_log_entries_logged_by_kind_check" CHECK ("logged_by_kind" IN ('user', 'agent'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_log_entries_contact_idx" ON "contact_log_entries" ("contact_id", "on" DESC, "created_at" DESC);
