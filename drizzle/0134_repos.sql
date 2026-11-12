-- GitHub repos in Drive (plan/github-drive.md §1, §3): fine-grained,
-- read-only personal access tokens and the repos they keep in sync.
--
-- The token is stored only as an AES-256-GCM envelope sealed with a key
-- derived from TENANT_MASTER_KEY (purpose "repo-source-token"), its AAD bound
-- to the row id. The page shows the last four characters, never the token.
CREATE TABLE IF NOT EXISTS "repo_source_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"github_login" text NOT NULL,
	"token_sealed" text NOT NULL,
	"last4" text NOT NULL,
	"expires_at" timestamp with time zone,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text
);
--> statement-breakpoint
-- One row per repo the company picked. Keyed on GitHub's numeric repo id, so
-- a rename survives. Claimed by the job-queue tick (FOR UPDATE SKIP LOCKED)
-- every 15 minutes; `snapshot` keeps the last fetched state so 304 answers
-- (ETags) can still be rendered.
CREATE TABLE IF NOT EXISTS "repo_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL REFERENCES "repo_source_tokens"("id") ON DELETE CASCADE,
	"repo_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_by" text,
	"claimed_until" timestamp with time zone,
	"etags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"branch_heads" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"doc_shas" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"snapshot" jsonb,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"paused_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_sources_repo_id_unique" UNIQUE ("repo_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repo_sources_due_idx" ON "repo_sources" ("due_at") WHERE "enabled";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repo_sources_token_idx" ON "repo_sources" ("token_id");
