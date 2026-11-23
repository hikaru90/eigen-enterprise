-- Company export (plan/phase-export.md X1): one row per "export everything" run. The archive
-- itself lives on disk under <state dir>/exports/<id>.zip; this row is its status and summary.
-- Owner only (kernel.export_company / export_status / export_list / export_delete).
CREATE TABLE IF NOT EXISTS "company_export" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "requested_by" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "bytes" bigint,
  "summary" jsonb,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  CONSTRAINT "company_export_status_check" CHECK ("status" IN ('pending', 'running', 'done', 'failed', 'deleted'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_export_created_idx" ON "company_export" ("created_at" DESC);
