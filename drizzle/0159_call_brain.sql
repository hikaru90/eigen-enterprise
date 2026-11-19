-- The Company Brain in a call (board 7f5f5423, round 2): off by default; a
-- company member in the call switches it on, anyone in it switches it off,
-- the call ending switches it off. It only listens (reads the transcript said
-- while it listened) and answers only when someone in the call asks — that
-- person alone, run as them — until they share the answer with the call.
-- Company-level tables (no RLS), like call: access is decided in the calls
-- service (modules/calls/service.ts); an unshared answer is read only by its
-- asker.

CREATE TABLE IF NOT EXISTS "call_brain_listen" (
	"id" uuid PRIMARY KEY NOT NULL,
	"call_id" uuid NOT NULL REFERENCES "call"("id") ON DELETE CASCADE,
	"on_by" text NOT NULL,
	"on_at" timestamp with time zone NOT NULL,
	"off_at" timestamp with time zone,
	"off_by" text,
	CONSTRAINT "call_brain_listen_time_check" CHECK ("off_at" IS NULL OR "off_at" >= "on_at"),
	CONSTRAINT "call_brain_listen_off_check" CHECK ("off_by" IS NULL OR "off_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_brain_listen_call_idx" ON "call_brain_listen" ("call_id", "on_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "call_brain_listen_open_idx" ON "call_brain_listen" ("call_id") WHERE "off_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "call_brain_answer" (
	"id" uuid PRIMARY KEY NOT NULL,
	"call_id" uuid NOT NULL REFERENCES "call"("id") ON DELETE CASCADE,
	"asked_by" text NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"asked_at" timestamp with time zone NOT NULL,
	"shared_at" timestamp with time zone,
	CONSTRAINT "call_brain_answer_question_check" CHECK (length("question") BETWEEN 1 AND 1000),
	CONSTRAINT "call_brain_answer_answer_check" CHECK (length("answer") BETWEEN 1 AND 20000),
	CONSTRAINT "call_brain_answer_shared_check" CHECK ("shared_at" IS NULL OR "shared_at" >= "asked_at")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_brain_answer_asker_idx" ON "call_brain_answer" ("call_id", "asked_by", "asked_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_brain_answer_shared_idx" ON "call_brain_answer" ("call_id", "shared_at") WHERE "shared_at" IS NOT NULL;
