-- Module hub (plan/phase-upgrades-u2.md §7): every module version installs
-- published, its receipt and summary, and which installs run it. Created on
-- every install, used only where the module-hub module is active (the central
-- box). install_id is the contribute hub's random install id, with no foreign
-- key: an install withdrawing its proposals never erases published code.

CREATE TABLE IF NOT EXISTS "hub_module_versions" (
	"bundle_sha256" text PRIMARY KEY NOT NULL,
	"install_id" uuid NOT NULL,
	"module_id" text NOT NULL,
	"version" text NOT NULL,
	"commit" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"core_api" text NOT NULL,
	"uses" jsonb NOT NULL,
	"provides" jsonb NOT NULL,
	"permissions" jsonb NOT NULL,
	"files" jsonb NOT NULL,
	"bytes" integer NOT NULL,
	"deprecated_uses" jsonb NOT NULL,
	"receipt" jsonb NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"summary" jsonb,
	"summary_at" timestamp with time zone,
	CONSTRAINT "hub_module_versions_commit_uq" UNIQUE ("install_id", "module_id", "commit"),
	CONSTRAINT "hub_module_versions_sha_check" CHECK ("bundle_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "hub_module_versions_commit_check" CHECK ("commit" ~ '^[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hub_module_versions_module_idx" ON "hub_module_versions" ("install_id", "module_id", "published_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hub_modules" (
	"install_id" uuid NOT NULL,
	"module_id" text NOT NULL,
	"name" text NOT NULL,
	"latest_bundle_sha256" text NOT NULL REFERENCES "hub_module_versions"("bundle_sha256"),
	"first_published_at" timestamp with time zone NOT NULL,
	"last_published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hub_modules_pk" PRIMARY KEY ("install_id", "module_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hub_modules_last_published_idx" ON "hub_modules" ("last_published_at");
--> statement-breakpoint
-- One slot per reporting install and module id: the release it runs and its state.
CREATE TABLE IF NOT EXISTS "hub_module_runs" (
	"install_id" uuid NOT NULL,
	"module_id" text NOT NULL,
	"bundle_sha256" text NOT NULL REFERENCES "hub_module_versions"("bundle_sha256"),
	"state" text NOT NULL,
	"reported_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hub_module_runs_pk" PRIMARY KEY ("install_id", "module_id"),
	CONSTRAINT "hub_module_runs_state_check" CHECK ("state" IN ('building', 'testing', 'starting', 'running', 'failed', 'stopped'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hub_module_runs_bundle_idx" ON "hub_module_runs" ("bundle_sha256");
