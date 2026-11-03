-- Team (plan/phase-workspace.md T1): groups of members and access grants.
-- access_grant is the shared contract Drive (folders/files) and Messages
-- (channels) check through src/lib/server/access. Deleting a user or a group
-- drops their memberships and grants (cascade).
CREATE TABLE IF NOT EXISTS "member_group" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "member_group_name_lower" ON "member_group" (lower("name"));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "member_group_member" (
	"group_id" text NOT NULL REFERENCES "member_group"("id") ON DELETE CASCADE,
	"user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_group_member_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "member_group_member_user_idx" ON "member_group_member" ("user_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "access_grant" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_type" text NOT NULL CHECK ("resource_type" IN ('channel', 'folder', 'file')),
	"resource_id" text NOT NULL,
	"subject_kind" text NOT NULL CHECK ("subject_kind" IN ('user', 'group', 'company')),
	"subject_user_id" text REFERENCES "user"("id") ON DELETE CASCADE,
	"subject_group_id" text REFERENCES "member_group"("id") ON DELETE CASCADE,
	"level" text NOT NULL CHECK ("level" IN ('view', 'edit', 'manage')),
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_grant_subject_shape" CHECK (
		("subject_kind" = 'user' AND "subject_user_id" IS NOT NULL AND "subject_group_id" IS NULL)
		OR ("subject_kind" = 'group' AND "subject_group_id" IS NOT NULL AND "subject_user_id" IS NULL)
		OR ("subject_kind" = 'company' AND "subject_user_id" IS NULL AND "subject_group_id" IS NULL)
	)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "access_grant_resource_idx" ON "access_grant" ("resource_type", "resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "access_grant_subject_unique" ON "access_grant" ("resource_type", "resource_id", "subject_kind", coalesce("subject_user_id", "subject_group_id", ''));
