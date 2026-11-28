-- Traces (plan/traces-phone-home.md T0): a model call's attempt number and structured outcome,
-- so neither has to be read back out of `operation`. Null on non-model rows and older rows.
ALTER TABLE "activity_call_log" ADD COLUMN IF NOT EXISTS "attempt" integer;
--> statement-breakpoint
ALTER TABLE "activity_call_log" ADD COLUMN IF NOT EXISTS "outcome" text;
