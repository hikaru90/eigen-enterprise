-- Real-time .xlsx workbook co-editing (plan/phase-office-files.md §7.4 & §7.9):
-- one server-authoritative session per workbook, its ordered SheetOp log, and
-- active peer presence across processes (web server + ee CLI).
CREATE TABLE IF NOT EXISTS "sheet_live_session" (
	"file_id" text PRIMARY KEY NOT NULL,
	"base_sha256" text NOT NULL,
	"base_seq" integer DEFAULT 0 NOT NULL,
	"head_seq" integer DEFAULT 0 NOT NULL,
	"epoch_seq" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"saved_at" timestamp with time zone,
	CONSTRAINT "sheet_live_session_seq_check" CHECK ("base_seq" >= 0 AND "head_seq" >= "base_seq" AND "epoch_seq" >= 0 AND "epoch_seq" <= "base_seq")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sheet_live_session_unsaved_idx" ON "sheet_live_session" USING btree ("updated_at") WHERE "head_seq" > "base_seq";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sheet_live_entry" (
	"file_id" text NOT NULL,
	"seq" integer NOT NULL,
	"client_id" text NOT NULL,
	"op_id" text NOT NULL,
	"author" jsonb NOT NULL,
	"body" jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "sheet_live_entry_pk" PRIMARY KEY ("file_id", "seq"),
	CONSTRAINT "sheet_live_entry_seq_check" CHECK ("seq" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sheet_live_entry_client_op_uq" ON "sheet_live_entry" USING btree ("file_id", "client_id", "op_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sheet_live_entry_file_at_idx" ON "sheet_live_entry" USING btree ("file_id", "at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sheet_live_peer" (
	"file_id" text NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"color" integer NOT NULL,
	"sheet" text,
	"range" text,
	"editing" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sheet_live_peer_pk" PRIMARY KEY ("file_id", "client_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sheet_live_peer_updated_idx" ON "sheet_live_peer" USING btree ("file_id", "updated_at");
