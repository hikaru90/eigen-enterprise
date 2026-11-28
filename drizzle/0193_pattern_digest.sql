-- What's happening (wish 75a4e570): the company brain's periodic digest of observable activity.
-- One row per digest; items carry their module and the roles their tools admit, so the
-- dashboard.patterns read filters per viewer. Company-level, no RLS.
CREATE TABLE IF NOT EXISTS "pattern_digest" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "window_start" timestamp with time zone NOT NULL,
  "window_end" timestamp with time zone NOT NULL,
  "items" jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS "pattern_digest_created_at_idx" ON "pattern_digest" ("created_at" DESC);
