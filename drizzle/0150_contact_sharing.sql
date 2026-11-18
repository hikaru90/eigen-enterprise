-- Contacts sharing (Contribute 9d28020a, Ony: share many at once, a "Whole
-- team" target that includes people who join later, and a default for new
-- contacts). Contacts stay a company-level table without RLS (0124): who sees
-- a contact is decided by the contacts service and its store's query.
--
-- * contacts.shared keeps its name and now reads "shared with the whole team":
--   every member of the company, now and later — checked when contacts are
--   read, never a copy of today's member ids. Existing shared contacts are
--   whole-team shares already, unchanged.
-- * contact_shares: a contact shared with one person or one group. A group
--   share follows the group's membership at read time. Removing a member or
--   deleting a group drops their shares (cascade), like access_grant (0107).
-- * contact_preferences: a person's own default for new contacts (no row =
--   follow the company's).
-- * contact_company_settings: one row, the company-wide default the owner or
--   an admin sets (no row = private).

CREATE TABLE IF NOT EXISTS "contact_shares" (
	"contact_id" uuid NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
	"subject_kind" text NOT NULL CHECK ("subject_kind" IN ('user', 'group')),
	"user_id" text REFERENCES "user"("id") ON DELETE CASCADE,
	"group_id" text REFERENCES "member_group"("id") ON DELETE CASCADE,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_shares_subject_shape" CHECK (
		("subject_kind" = 'user' AND "user_id" IS NOT NULL AND "group_id" IS NULL)
		OR ("subject_kind" = 'group' AND "group_id" IS NOT NULL AND "user_id" IS NULL)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contact_shares_subject_unique" ON "contact_shares" ("contact_id", "subject_kind", coalesce("user_id", "group_id"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_shares_user_idx" ON "contact_shares" ("user_id") WHERE "user_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_shares_group_idx" ON "contact_shares" ("group_id") WHERE "group_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_preferences" (
	"user_id" text PRIMARY KEY NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
	"default_visibility" text NOT NULL CHECK ("default_visibility" IN ('private', 'team')),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_company_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL CHECK ("id"),
	"default_visibility" text NOT NULL CHECK ("default_visibility" IN ('private', 'team')),
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
COMMENT ON COLUMN "contacts"."shared" IS 'Shared with the whole team: every member of the company, now and later (0150).';
