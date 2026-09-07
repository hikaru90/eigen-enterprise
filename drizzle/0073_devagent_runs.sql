CREATE TABLE IF NOT EXISTS "kernel_devagent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task" text NOT NULL,
	"status" text NOT NULL,
	"branch" text NOT NULL,
	"worktree_path" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"result_summary" text,
	"green" boolean,
	"error" text
);
