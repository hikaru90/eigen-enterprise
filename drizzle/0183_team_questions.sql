-- Team questions (Contribute 057cd4d5, Ony): a member puts a short question to
-- the company or to chosen groups and people; they read it and answer it in
-- Memory › Questions (not the chat). Free tags chosen by the asker (categories,
-- topics). Company-level tables (no RLS), like assigned tasks, messages and
-- calls: access is decided in the service (src/lib/server/memory/team-questions):
-- the asker and the audience read a question — the whole company, or the
-- chosen groups (member_group, membership read at the time) and people.
-- Only the asker closes it; answers land while it is open.
CREATE TABLE IF NOT EXISTS "team_questions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"author_id" text NOT NULL,
	"text" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"audience_kind" text NOT NULL,
	"audience_group_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"audience_user_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_via" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "team_questions_text_check" CHECK (length(btrim("text")) BETWEEN 1 AND 500),
	CONSTRAINT "team_questions_tags_check" CHECK (cardinality("tags") <= 8),
	CONSTRAINT "team_questions_audience_check" CHECK (
		("audience_kind" = 'company' AND cardinality("audience_group_ids") = 0 AND cardinality("audience_user_ids") = 0)
		OR ("audience_kind" = 'chosen' AND cardinality("audience_group_ids") + cardinality("audience_user_ids") > 0)
	),
	CONSTRAINT "team_questions_status_check" CHECK ("status" IN ('open', 'closed')),
	CONSTRAINT "team_questions_closed_check" CHECK (("status" = 'closed') = ("closed_at" IS NOT NULL)),
	CONSTRAINT "team_questions_created_via_check" CHECK ("created_via" IN ('person', 'assistant'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_questions_created_idx" ON "team_questions" ("created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_questions_tags_idx" ON "team_questions" USING gin ("tags");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "team_question_answers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"question_id" uuid NOT NULL REFERENCES "team_questions"("id") ON DELETE CASCADE,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"created_via" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_question_answers_body_check" CHECK (length(btrim("body")) BETWEEN 1 AND 4000),
	CONSTRAINT "team_question_answers_created_via_check" CHECK ("created_via" IN ('person', 'assistant'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_question_answers_question_idx" ON "team_question_answers" ("question_id", "created_at");
