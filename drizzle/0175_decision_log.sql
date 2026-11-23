-- CB2 · Jev in the gateway (plan/phase-company-brain.md §5, §10): every decision of a
-- declared decision kind (src/lib/server/decisions, kinds declared next to their module's
-- code) is one row here — what Jev chose, with its confidence and distribution, next to the
-- current judge's answer while the kind runs in shadow, and a person's answer when Jev was
-- unsure (a "Needs you" question: ask_user_id set, human_choice filled when they answer).
-- Agreement per kind (decisions.kinds) is read from these rows; a kind's status changes only
-- by a commit, after the log was reviewed.
--
-- input is the kind's own log view of what was decided (logInput, then key-based secret
-- redaction): never a mail body or a private text unless the kind chose to keep it.
-- input_digest (sha256 of the full input) links a re-ask to its question.
--
-- Company-level table without RLS (like coworker_run_notice): the decisions.* tools decide
-- who reads what — owner and admins every row, a member the rows about them, asked by them
-- or asked of them.
CREATE TABLE IF NOT EXISTS "decision_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "module" text NOT NULL,
  "status" text NOT NULL,
  "outcome" text NOT NULL,
  "input_digest" text NOT NULL,
  "input" jsonb NOT NULL,
  "jev_choice" text,
  "jev_confidence" double precision,
  "jev_distribution" jsonb,
  "jev_error" text,
  "model" text,
  "cost_usd" numeric(14, 10),
  "duration_ms" integer,
  "judge_choice" text,
  "used_choice" text,
  "used_source" text,
  "subject_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "requested_by" text NOT NULL,
  "ask_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "question" text,
  "human_choice" text,
  "labelled_by" text,
  "labelled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "decision_log_status_check" CHECK ("status" IN ('shadow', 'enforced')),
  CONSTRAINT "decision_log_outcome_check" CHECK ("outcome" IN ('decided', 'pending', 'observed', 'failed')),
  CONSTRAINT "decision_log_used_source_check" CHECK ("used_source" IS NULL OR "used_source" IN ('jev', 'current_judge', 'human')),
  CONSTRAINT "decision_log_confidence_check" CHECK ("jev_confidence" IS NULL OR ("jev_confidence" >= 0 AND "jev_confidence" <= 1)),
  CONSTRAINT "decision_log_question_check" CHECK ("outcome" <> 'pending' OR ("ask_user_id" IS NOT NULL AND "question" IS NOT NULL)),
  CONSTRAINT "decision_log_label_check" CHECK (("human_choice" IS NULL) = ("labelled_at" IS NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_log_kind_idx" ON "decision_log" ("kind", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_log_digest_idx" ON "decision_log" ("kind", "input_digest");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "decision_log_open_question_idx" ON "decision_log" ("ask_user_id", "created_at") WHERE "outcome" = 'pending' AND "human_choice" IS NULL;
