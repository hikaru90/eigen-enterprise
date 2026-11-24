-- Multi-manager reporting for the org chart (contribution 955e5f85): a seat
-- (person or AI co-worker) may report to more than one manager.
-- org_position.reports_to_user_id stays synced to position 0 for backwards compatibility.
CREATE TABLE IF NOT EXISTS "org_position_report" (
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "reports_to_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "position" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "org_position_report_pk" PRIMARY KEY ("user_id", "reports_to_user_id"),
  CONSTRAINT "org_position_report_not_self" CHECK ("user_id" <> "reports_to_user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_position_report_manager_idx" ON "org_position_report" ("reports_to_user_id");
--> statement-breakpoint
INSERT INTO "org_position_report" ("user_id", "reports_to_user_id", "position")
SELECT "user_id", "reports_to_user_id", 0
FROM "org_position"
WHERE "reports_to_user_id" IS NOT NULL
ON CONFLICT ("user_id", "reports_to_user_id") DO NOTHING;
