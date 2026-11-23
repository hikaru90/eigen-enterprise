-- AI co-workers (plan/phase-ai-coworkers.md §3, §4, C1): an AI co-worker is a `user` row with
-- kind 'coworker' (its own seat: thoughts, cost, messages, grants and RLS all key on user.id).
-- It never signs in: it has no account or credential row, and Better Auth refuses a session for
-- it (src/lib/server/auth/coworker-sign-in.ts). Every existing user is a person ('human').
--
-- org_position is the company-wide org chart (people and co-workers alike); coworker_profile is a
-- co-worker's role card and runtime settings; coworker_run is its visible run log (written from C3).
--
-- RLS: these three are company-level tables like member_group and access_grant (no tenant
-- policy): the org chart and the co-workers are readable by every member, and every write goes
-- through the coworkers.* / org.* registry tools, which decide who may (admins; a member edits
-- only their own title and accountabilities). Nothing private lives here.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'human' NOT NULL;
--> statement-breakpoint
ALTER TABLE "user" DROP CONSTRAINT IF EXISTS "user_kind_check";
--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_kind_check" CHECK ("kind" IN ('human', 'coworker'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_position" (
  "user_id" text PRIMARY KEY NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "title" text,
  "reports_to_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "accountabilities" text[] DEFAULT '{}' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" text NOT NULL,
  CONSTRAINT "org_position_not_self" CHECK ("reports_to_user_id" IS NULL OR "reports_to_user_id" <> "user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_position_reports_to_idx" ON "org_position" ("reports_to_user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "coworker_profile" (
  "user_id" text PRIMARY KEY NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "slug" text NOT NULL,
  "lens" text NOT NULL,
  "model_id" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "daily_cap_usd" numeric(12, 4) NOT NULL,
  "template_id" text,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "removed_at" timestamp with time zone,
  "removed_by" text,
  CONSTRAINT "coworker_profile_daily_cap_positive" CHECK ("daily_cap_usd" > 0),
  CONSTRAINT "coworker_profile_removed_is_disabled" CHECK ("removed_at" IS NULL OR "enabled" = false)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "coworker_profile_slug_unique" ON "coworker_profile" ("slug");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "coworker_run" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "coworker_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "trigger_kind" text NOT NULL,
  "conversation_id" uuid REFERENCES "message_conversations"("id") ON DELETE SET NULL,
  "thread_root_id" uuid REFERENCES "messages"("id") ON DELETE SET NULL,
  "requested_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ended_at" timestamp with time zone,
  "error" text,
  CONSTRAINT "coworker_run_trigger_kind_check" CHECK ("trigger_kind" IN ('mention', 'dm', 'assignment', 'rhythm', 'event')),
  CONSTRAINT "coworker_run_status_check" CHECK ("status" IN ('running', 'done', 'failed', 'stopped'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coworker_run_coworker_started_idx" ON "coworker_run" ("coworker_user_id", "started_at" DESC);
