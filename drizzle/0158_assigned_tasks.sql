-- Assigned tasks (Contribute: "assign a task to another member"). One member
-- assigns a task to another — a member of the company (the user table), never
-- a contact. Memory stays private per person (RLS on thought); an assigned task
-- is not a thought: it is a company-level record both people read, so the
-- assignee sees the title, context and due date without any of the
-- assigner's Memory. Company-level tables (no RLS), like messages and calls:
-- access is decided in the service (src/lib/server/memory/assigned-tasks):
-- only the assigner and the assignee ever read or change a task.
-- *_update / *_update_at: the latest thing that happened for that person
-- (the assignee: assigned, commented; the assigner: completed, commented);
-- *_seen_at: when they last acknowledged it. Unseen = update_at > seen_at.
CREATE TABLE IF NOT EXISTS "assigned_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"assigner_id" text NOT NULL,
	"assignee_id" text NOT NULL,
	"title" text NOT NULL,
	"context" text DEFAULT '' NOT NULL,
	"due_on" date,
	"status" text DEFAULT 'open' NOT NULL,
	"created_via" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"assignee_update" text,
	"assignee_update_at" timestamp with time zone,
	"assignee_seen_at" timestamp with time zone,
	"assigner_update" text,
	"assigner_update_at" timestamp with time zone,
	"assigner_seen_at" timestamp with time zone,
	CONSTRAINT "assigned_tasks_people_check" CHECK ("assigner_id" <> "assignee_id"),
	CONSTRAINT "assigned_tasks_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 200),
	CONSTRAINT "assigned_tasks_context_check" CHECK (length("context") <= 4000),
	CONSTRAINT "assigned_tasks_status_check" CHECK ("status" IN ('open', 'done')),
	CONSTRAINT "assigned_tasks_completed_check" CHECK (("status" = 'done') = ("completed_at" IS NOT NULL)),
	CONSTRAINT "assigned_tasks_created_via_check" CHECK ("created_via" IN ('person', 'assistant')),
	CONSTRAINT "assigned_tasks_assignee_update_check" CHECK (
		("assignee_update" IS NULL) = ("assignee_update_at" IS NULL)
		AND ("assignee_update" IS NULL OR "assignee_update" IN ('assigned', 'commented'))
	),
	CONSTRAINT "assigned_tasks_assigner_update_check" CHECK (
		("assigner_update" IS NULL) = ("assigner_update_at" IS NULL)
		AND ("assigner_update" IS NULL OR "assigner_update" IN ('completed', 'commented'))
	)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assigned_tasks_assignee_idx" ON "assigned_tasks" ("assignee_id", "status", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assigned_tasks_assigner_idx" ON "assigned_tasks" ("assigner_id", "created_at" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assigned_task_comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL REFERENCES "assigned_tasks"("id") ON DELETE CASCADE,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assigned_task_comments_body_check" CHECK (length(btrim("body")) BETWEEN 1 AND 4000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assigned_task_comments_task_idx" ON "assigned_task_comments" ("task_id", "created_at");
