-- Private repos through read-only deploy keys (plan/github-connect.md). The
-- key pair lives in ee's sealed secret store; this table only records which
-- auth a connected repo uses and, for a deploy key, ee's key id. No key
-- material is ever stored here.
--
-- A deploy-key repo is never read through the GitHub API (no token), so it has
-- no numeric repo id: repo_id becomes nullable, and rows are unique by
-- (repo_id, branch) where the id is known and by (lower(full_name), branch).

ALTER TABLE "github_connected_repos" DROP CONSTRAINT IF EXISTS "github_connected_repos_pk";--> statement-breakpoint
ALTER TABLE "github_connected_repos" DROP CONSTRAINT IF EXISTS "github_connected_repos_private_has_installation";--> statement-breakpoint
ALTER TABLE "github_connected_repos" ALTER COLUMN "repo_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "github_connected_repos" ADD COLUMN IF NOT EXISTS "auth_kind" text;--> statement-breakpoint
ALTER TABLE "github_connected_repos" ADD COLUMN IF NOT EXISTS "deploy_key_id" text;--> statement-breakpoint
UPDATE "github_connected_repos" SET "auth_kind" = CASE WHEN "visibility" = 'private' THEN 'github_app' ELSE 'public' END WHERE "auth_kind" IS NULL;--> statement-breakpoint
ALTER TABLE "github_connected_repos" ALTER COLUMN "auth_kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "github_connected_repos" ADD CONSTRAINT "github_connected_repos_auth_kind_check" CHECK ("auth_kind" IN ('public', 'github_app', 'deploy_key'));--> statement-breakpoint
ALTER TABLE "github_connected_repos" ADD CONSTRAINT "github_connected_repos_auth_shape" CHECK (
	("auth_kind" = 'public' AND "visibility" = 'public' AND "repo_id" IS NOT NULL AND "installation_id" IS NULL AND "deploy_key_id" IS NULL)
	OR ("auth_kind" = 'github_app' AND "visibility" = 'private' AND "repo_id" IS NOT NULL AND "installation_id" IS NOT NULL AND "deploy_key_id" IS NULL)
	OR ("auth_kind" = 'deploy_key' AND "visibility" = 'private' AND "installation_id" IS NULL AND "deploy_key_id" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "github_connected_repos" ADD CONSTRAINT "github_connected_repos_repo_branch_unique" UNIQUE ("repo_id", "branch");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "github_connected_repos_name_branch_unique" ON "github_connected_repos" (lower("full_name"), "branch");
