-- Traces phone-home (plan/traces-phone-home.md T2): the box side. The single settings row (on by
-- default, owner 2026-11-25) with the per-install salt export ids are made with (it never leaves
-- the box); a cursor per source table; every batch exactly as sent ("What was sent"); and the Jev
-- verdicts on open values (T1b), one per distinct value.
CREATE TABLE IF NOT EXISTS "trace_share_settings" (
  "id" smallint PRIMARY KEY DEFAULT 1,
  "enabled" boolean DEFAULT true NOT NULL,
  "salt" text NOT NULL,
  "last_sent_at" timestamp with time zone,
  "last_error" text,
  "updated_by" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "trace_share_settings_singleton" CHECK ("id" = 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trace_export_cursor" (
  "source" text PRIMARY KEY,
  "last_at" timestamp with time zone NOT NULL,
  "last_id" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trace_batch" (
  "id" uuid PRIMARY KEY,
  "state" text NOT NULL,
  "span_count" integer NOT NULL,
  "body" jsonb NOT NULL,
  "withheld" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "sent_at" timestamp with time zone,
  "withdrawn_at" timestamp with time zone,
  CONSTRAINT "trace_batch_state" CHECK ("state" IN ('pending', 'sent', 'failed', 'withdrawn'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trace_batch_created_idx" ON "trace_batch" ("created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trace_value_verdict" (
  "field" text NOT NULL,
  "value" text NOT NULL,
  "verdict" text NOT NULL,
  "decided_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "trace_value_verdict_pk" PRIMARY KEY ("field", "value"),
  CONSTRAINT "trace_value_verdict_choice" CHECK ("verdict" IN ('usage_meta', 'personal_or_content'))
);
