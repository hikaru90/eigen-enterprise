-- Traces phone-home, the hub side (plan/traces-phone-home.md T3): used only where the trace-hub
-- module is active (os.cerberusblue.com). Tier A spans only (no content exists in the schema),
-- kept 90 days; daily rollups (counts, p50/p95 durations, errors, tokens, cost) kept indefinitely.
CREATE TABLE IF NOT EXISTS "hub_trace_batches" (
  "install_id" uuid NOT NULL,
  "batch_id" uuid NOT NULL,
  "span_count" integer NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "hub_trace_batches_pk" PRIMARY KEY ("install_id", "batch_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hub_trace_spans" (
  "install_id" uuid NOT NULL,
  "batch_id" uuid NOT NULL,
  "trace_id" uuid NOT NULL,
  "span_id" uuid NOT NULL,
  "parent_id" uuid,
  "kind" text NOT NULL,
  "run_kind" text,
  "tool" text,
  "log_context" text,
  "model" text,
  "provider_kind" text,
  "tokens_in" integer,
  "tokens_out" integer,
  "cost_usd" double precision,
  "duration_ms" integer,
  "attempt" integer,
  "start_offset_ms" integer NOT NULL,
  "outcome" text NOT NULL,
  "error_code" text,
  "audit_class" text,
  "via" text,
  "app_version" text NOT NULL,
  "ee_version" text,
  "day" date NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "hub_trace_spans_pk" PRIMARY KEY ("install_id", "span_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hub_trace_spans_day_idx" ON "hub_trace_spans" ("day");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hub_trace_spans_trace_idx" ON "hub_trace_spans" ("install_id", "trace_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hub_trace_daily" (
  "day" date NOT NULL,
  "kind" text NOT NULL,
  "tool" text DEFAULT '' NOT NULL,
  "model" text DEFAULT '' NOT NULL,
  "log_context" text DEFAULT '' NOT NULL,
  "app_version" text NOT NULL,
  "spans" integer NOT NULL,
  "errors" integer NOT NULL,
  "installs" integer NOT NULL,
  "p50_ms" integer,
  "p95_ms" integer,
  "tokens_in" bigint NOT NULL,
  "tokens_out" bigint NOT NULL,
  "cost_usd" double precision NOT NULL,
  CONSTRAINT "hub_trace_daily_pk" PRIMARY KEY ("day", "kind", "tool", "model", "log_context", "app_version")
);
