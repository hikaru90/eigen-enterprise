-- Services deployed from connected GitHub repos (plan/phase-platform.md step 3,
-- plan/github-connect.md "deploy"). One row per ee app workload: which
-- connected repo + branch it builds from, its kind and host, and what the last
-- deploy did. The build contract itself lives in ee's company repo (desired
-- state), never here and never in the app's repo; env values live sealed in
-- ee's secret store, never here.

CREATE TABLE IF NOT EXISTS "website_services" (
	"name" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"branch" text NOT NULL,
	"repo_id" bigint,
	"auth_kind" text NOT NULL,
	"host" text,
	"auto_deploy" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'new' NOT NULL,
	"last_rev" text,
	"last_error" text,
	"last_deployed_at" timestamp with time zone,
	"last_deployed_by" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "website_services_name_check" CHECK ("name" ~ '^[a-z][a-z0-9-]{1,30}$'),
	CONSTRAINT "website_services_kind_check" CHECK ("kind" IN ('web', 'backend')),
	CONSTRAINT "website_services_auth_kind_check" CHECK ("auth_kind" IN ('public', 'github_app', 'deploy_key')),
	CONSTRAINT "website_services_state_check" CHECK ("state" IN ('new', 'deploying', 'healthy', 'failed')),
	-- Push-to-deploy exists only for App repos (deploy keys get no webhooks).
	CONSTRAINT "website_services_auto_deploy_app_only" CHECK (NOT "auto_deploy" OR ("auth_kind" = 'github_app' AND "repo_id" IS NOT NULL)),
	CONSTRAINT "website_services_web_has_host" CHECK ("kind" <> 'web' OR "host" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "website_services_repo_branch_idx" ON "website_services" ("repo_id", "branch");
