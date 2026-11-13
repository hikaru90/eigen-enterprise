-- Contribute hub (plan/contribute-phone-home.md §3): the central board that
-- installs share de-personalised proposals with. Created on every install,
-- used only where the contribute-hub module is active (os.cerberusblue.com).
-- No company, person or host column exists here by design.

CREATE TABLE IF NOT EXISTS "hub_installs" (
	"install_id" uuid PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"app_version" text NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hub_contributions" (
	"install_id" uuid NOT NULL REFERENCES "hub_installs"("install_id") ON DELETE CASCADE,
	"remote_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"language" text NOT NULL,
	"kind" text NOT NULL,
	"area" text NOT NULL,
	"status" text NOT NULL,
	"score" integer NOT NULL,
	"app_version" text NOT NULL,
	"created_day" date NOT NULL,
	"shipped_day" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_contributions_pk" PRIMARY KEY ("install_id", "remote_id"),
	CONSTRAINT "hub_contributions_summary_check" CHECK (length("summary") BETWEEN 1 AND 500),
	CONSTRAINT "hub_contributions_kind_check" CHECK ("kind" IN ('idea', 'bug', 'polish')),
	CONSTRAINT "hub_contributions_area_check" CHECK ("area" IN ('dashboard', 'assistant', 'messages', 'website', 'email', 'brand', 'memory', 'drive', 'settings', 'contribute', 'everywhere')),
	CONSTRAINT "hub_contributions_status_check" CHECK ("status" IN ('requested', 'in_progress', 'shipped', 'declined'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hub_contributions_status_idx" ON "hub_contributions" ("status", "created_day" DESC);
--> statement-breakpoint
-- Replay guard: a signature seen inside the skew window is refused; rows older than the window are pruned.
CREATE TABLE IF NOT EXISTS "hub_seen_signatures" (
	"signature_hash" text PRIMARY KEY NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Rate limit: requests per install per hour bucket.
CREATE TABLE IF NOT EXISTS "hub_request_counts" (
	"install_id" uuid NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "hub_request_counts_pk" PRIMARY KEY ("install_id", "hour")
);
