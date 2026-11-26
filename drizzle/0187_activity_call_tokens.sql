-- Token counts per model call, prompt-cache reads and writes included (cost transparency).
ALTER TABLE "activity_call_log" ADD COLUMN IF NOT EXISTS "prompt_tokens" integer;
ALTER TABLE "activity_call_log" ADD COLUMN IF NOT EXISTS "completion_tokens" integer;
ALTER TABLE "activity_call_log" ADD COLUMN IF NOT EXISTS "cached_tokens" integer;
ALTER TABLE "activity_call_log" ADD COLUMN IF NOT EXISTS "cache_write_tokens" integer;
