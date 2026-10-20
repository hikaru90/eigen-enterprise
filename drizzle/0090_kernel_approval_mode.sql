-- Company-wide approval mode the owner picks under the chat input.
-- One row. Seeded explicitly with 'ask' (today's behaviour) — the code has no default.
CREATE TABLE IF NOT EXISTS "kernel_approval_mode" (
	"id" text PRIMARY KEY DEFAULT 'company' NOT NULL,
	"mode" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kernel_approval_mode_singleton" CHECK ("id" = 'company'),
	CONSTRAINT "kernel_approval_mode_mode_check" CHECK ("mode" IN ('ask', 'reasonable', 'allow_all'))
);
--> statement-breakpoint
INSERT INTO "kernel_approval_mode" ("id", "mode", "updated_by") VALUES ('company', 'ask', 'migration:0090') ON CONFLICT ("id") DO NOTHING;
