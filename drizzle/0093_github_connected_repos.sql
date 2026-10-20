-- Connected GitHub repositories (plan/github-connect.md): what a later deploy
-- needs — GitHub's numeric repo id, the branch, and for private repos the App
-- installation id. No tokens are stored; installation tokens are minted on
-- demand from the sealed App key in github_connection.

CREATE TABLE IF NOT EXISTS "github_connected_repos" (
	"repo_id" bigint NOT NULL,
	"branch" text NOT NULL,
	"full_name" text NOT NULL,
	"html_url" text NOT NULL,
	"clone_url" text NOT NULL,
	"visibility" text NOT NULL,
	"installation_id" bigint,
	"connected_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_connected_repos_pk" PRIMARY KEY ("repo_id", "branch"),
	CONSTRAINT "github_connected_repos_visibility_check" CHECK ("visibility" IN ('public', 'private')),
	CONSTRAINT "github_connected_repos_private_has_installation" CHECK ("visibility" = 'public' OR "installation_id" IS NOT NULL)
);
