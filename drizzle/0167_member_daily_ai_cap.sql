-- Per-person daily AI cap (plan/phase-demo-company.md D2, DC3). A company setting in USD:
-- NULL = no cap. It applies to people with role `member` (owner and admins are exempt) and
-- is counted per person per UTC day from activity_call_log.total_cost_usd. Set through the
-- registry tool settings.member_ai_cap_set (Settings → AI provider is its client).
ALTER TABLE "company_ai" ADD COLUMN IF NOT EXISTS "member_daily_cap_usd" numeric(12, 4);
--> statement-breakpoint
ALTER TABLE "company_ai" DROP CONSTRAINT IF EXISTS "company_ai_member_daily_cap_positive";
--> statement-breakpoint
ALTER TABLE "company_ai" ADD CONSTRAINT "company_ai_member_daily_cap_positive" CHECK ("member_daily_cap_usd" IS NULL OR "member_daily_cap_usd" > 0);
