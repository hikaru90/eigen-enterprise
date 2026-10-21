-- Company members with roles (owner | admin | member) and email invites.
-- The former owner is the earliest production admin account; 'user' becomes 'member'.
ALTER TABLE "user" DROP CONSTRAINT IF EXISTS "user_role_check";--> statement-breakpoint
UPDATE "user" SET "role" = 'member' WHERE "role" = 'user';--> statement-breakpoint
UPDATE "user" SET "role" = 'owner' WHERE "id" = (
	SELECT "id" FROM "user" WHERE "role" = 'admin' AND "account_kind" = 'production' ORDER BY "created_at" ASC, "id" ASC LIMIT 1
) AND NOT EXISTS (SELECT 1 FROM "user" WHERE "role" = 'owner');--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "role" SET DEFAULT 'member';--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_role_check" CHECK ("role" IN ('owner', 'admin', 'member'));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_single_owner" ON "user" ("role") WHERE "role" = 'owner';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "member_invite" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL CHECK ("role" IN ('admin', 'member')),
	"token_hash" text NOT NULL UNIQUE,
	"invited_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "claim_consumed" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
