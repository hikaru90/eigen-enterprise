-- A capture session keeps the raw text a person typed. It had no link to the thought it
-- became once the capture was confirmed (the confirmation rewrites thought.metadata and drops
-- metadata.captureSessionId), so deleting the thought left that raw text behind. The link
-- makes the session go with its thought.
ALTER TABLE "capture_session"
  ADD COLUMN IF NOT EXISTS "thought_id" uuid REFERENCES "thought"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "capture_session_thought_idx" ON "capture_session" ("thought_id");
--> statement-breakpoint
-- Backfill: queue-capture inserts the session and its thought in one transaction, so the
-- thought either still names the session in its metadata or shares the transaction's
-- now() as created_at (thought.created_at differs only for backdated captures).
UPDATE "capture_session" cs
SET "thought_id" = t."id"
FROM "thought" t
WHERE cs."thought_id" IS NULL
  AND t."user_id" = cs."user_id"
  AND t."metadata" ->> 'captureSessionId' = cs."id"::text;
--> statement-breakpoint
UPDATE "capture_session" cs
SET "thought_id" = t."id"
FROM "thought" t
WHERE cs."thought_id" IS NULL
  AND t."user_id" = cs."user_id"
  AND t."created_at" = cs."created_at"
  AND NOT EXISTS (SELECT 1 FROM "capture_session" o WHERE o."thought_id" = t."id");
