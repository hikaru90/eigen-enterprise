-- Labels in the inbox (owner, 2026-11-14: "an inbox has categories, folders, labels"):
-- named per mailbox (a shared mailbox's readers share its labels), any number per mail.
CREATE TABLE "inbox_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mailbox_id" uuid NOT NULL REFERENCES "mailboxes"("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_labels_name_idx" ON "inbox_labels" ("mailbox_id", lower("name"));--> statement-breakpoint
CREATE TABLE "inbox_message_labels" (
	"message_id" uuid NOT NULL REFERENCES "inbox_messages"("id") ON DELETE CASCADE,
	"label_id" uuid NOT NULL REFERENCES "inbox_labels"("id") ON DELETE CASCADE,
	PRIMARY KEY ("message_id", "label_id")
);--> statement-breakpoint
CREATE INDEX "inbox_message_labels_label_idx" ON "inbox_message_labels" ("label_id");
