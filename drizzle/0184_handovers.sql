-- Handover (Contribute b92e6ba5, plan/handover.md): a page per person or per
-- topic where the company brain and its owner keep the current state, readable
-- by everyone in the company. One entry per topic: the day it speaks for, the
-- topic, one sentence, a status (decision_needed / in_progress / for_info) and
-- a link to the detail document or item. Company-level tables (no RLS), like
-- assigned tasks: every member reads every handover; only its owner writes —
-- decided in the service (src/lib/server/memory/handover/service.ts).
-- assignee_id / assigned_task_id: an entry assigned to a member carries an
-- assigned task (0158) that puts it in their Needs you; null = information.
CREATE TABLE IF NOT EXISTS "handovers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"subject_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handovers_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "handovers_updated_idx" ON "handovers" ("updated_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "handover_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"handover_id" uuid NOT NULL REFERENCES "handovers"("id") ON DELETE CASCADE,
	"entry_on" date NOT NULL,
	"topic" text NOT NULL,
	"sentence" text NOT NULL,
	"status" text NOT NULL,
	"link" text,
	"assignee_id" text,
	"assigned_task_id" uuid REFERENCES "assigned_tasks"("id") ON DELETE SET NULL,
	"written_via" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handover_entries_topic_check" CHECK (length(btrim("topic")) BETWEEN 1 AND 120),
	CONSTRAINT "handover_entries_sentence_check" CHECK (length(btrim("sentence")) BETWEEN 1 AND 400),
	CONSTRAINT "handover_entries_status_check" CHECK ("status" IN ('decision_needed', 'in_progress', 'for_info')),
	CONSTRAINT "handover_entries_link_check" CHECK ("link" IS NULL OR length("link") <= 2000),
	CONSTRAINT "handover_entries_written_via_check" CHECK ("written_via" IN ('person', 'assistant', 'brain'))
);
--> statement-breakpoint
-- One entry per topic: the same words, whatever the case or outer spaces.
CREATE UNIQUE INDEX IF NOT EXISTS "handover_entries_topic_uidx" ON "handover_entries" ("handover_id", lower(btrim("topic")));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "handover_entries_newest_idx" ON "handover_entries" ("handover_id", "entry_on", "updated_at");
