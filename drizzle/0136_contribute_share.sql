-- Contribute phone-home, install side (plan/contribute-phone-home.md §5).
-- contribute_outbox: one row per proposal this install shares with the
-- central board — its scrubbed summary and where sending stands.
-- contribute_share_settings: the single sharing row (on by default, owner
-- Q6). The install's private signing key lives in the secrets store, never
-- here. Proposals made before this migration are never shared (no backfill,
-- owner Q7): they get an `excluded` row.

CREATE TABLE IF NOT EXISTS "contribute_outbox" (
	"contribution_id" uuid PRIMARY KEY NOT NULL REFERENCES "contributions"("id") ON DELETE CASCADE,
	"state" text DEFAULT 'pending' NOT NULL,
	"summary" text,
	"language" text,
	"last_sent_hash" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contribute_outbox_state_check" CHECK ("state" IN ('pending', 'scrubbed', 'sent', 'failed', 'excluded')),
	CONSTRAINT "contribute_outbox_summary_check" CHECK ("summary" IS NULL OR length("summary") BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contribute_outbox_due_idx" ON "contribute_outbox" ("next_attempt_at") WHERE "state" IN ('pending', 'scrubbed');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contribute_share_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"install_id" uuid,
	"registered_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contribute_share_settings_single_row" CHECK ("id" = 1)
);
--> statement-breakpoint
INSERT INTO "contribute_share_settings" ("id", "enabled") VALUES (1, true) ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "contribute_outbox" ("contribution_id", "state")
SELECT "id", 'excluded' FROM "contributions"
ON CONFLICT ("contribution_id") DO NOTHING;
