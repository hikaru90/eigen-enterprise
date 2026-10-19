-- GitHub as a source provider (plan/phase-substrate.md D12): one GitHub App per
-- company, created through GitHub's manifest flow from Settings → GitHub.
-- The app's private key, webhook secret and client secret are stored only as an
-- AES-256-GCM envelope (sealed with the instance TENANT_MASTER_KEY) — never in
-- plain columns. Links map a deployed app (an ee workload) to its repository.

CREATE TABLE IF NOT EXISTS "github_connection" (
	"id" text PRIMARY KEY DEFAULT 'github' NOT NULL,
	"app_id" bigint NOT NULL,
	"app_slug" text NOT NULL,
	"client_id" text NOT NULL,
	"html_url" text NOT NULL,
	"sealed_credentials" text NOT NULL,
	"installation_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_connection_singleton" CHECK ("id" = 'github')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "github_app_links" (
	"workload" text PRIMARY KEY NOT NULL,
	"repo_full_name" text NOT NULL,
	"ref" text NOT NULL,
	"auto_deploy" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_app_links_workload_check" CHECK ("workload" ~ '^[a-z][a-z0-9-]{1,30}$')
);
