-- Mailboxes (plan/email-inbox.md S1): the addresses the company receives mail
-- on, and the mail they hold. Owner decisions 2026-11-12: the owner assigns
-- each address by hand; a personal mailbox is read only by its member (not the
-- owner, not admins, not agents); a shared mailbox (info@, sales@) is read by
-- one group. Company-level tables (no RLS), like contacts and mail_*: who may
-- read what is decided in modules/email/inbox/service.ts.
-- Not mail_messages (that is the company's sent-mail log).

CREATE TABLE IF NOT EXISTS "mailboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"owner_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
	"group_id" text,
	"display_name" text,
	"disabled_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailboxes_kind_check" CHECK ("kind" IN ('personal', 'shared')),
	CONSTRAINT "mailboxes_shared_group_check" CHECK ("kind" <> 'shared' OR "group_id" IS NOT NULL),
	CONSTRAINT "mailboxes_personal_no_group_check" CHECK ("kind" <> 'personal' OR "group_id" IS NULL),
	CONSTRAINT "mailboxes_display_name_check" CHECK ("display_name" IS NULL OR length(btrim("display_name")) BETWEEN 1 AND 120)
);
--> statement-breakpoint
-- One personal mailbox per member; more addresses are aliases.
CREATE UNIQUE INDEX IF NOT EXISTS "mailboxes_personal_owner_idx" ON "mailboxes" ("owner_user_id") WHERE "kind" = 'personal';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mailboxes_group_idx" ON "mailboxes" ("group_id") WHERE "group_id" IS NOT NULL;
--> statement-breakpoint
-- Every receiving address, unique across the company: one primary per mailbox, the rest aliases.
CREATE TABLE IF NOT EXISTS "mailbox_addresses" (
	"address" text PRIMARY KEY NOT NULL,
	"mailbox_id" uuid NOT NULL REFERENCES "mailboxes"("id") ON DELETE CASCADE,
	"domain_id" uuid NOT NULL REFERENCES "mail_domains"("id") ON DELETE RESTRICT,
	"is_primary" boolean NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_addresses_lower_check" CHECK ("address" = lower("address") AND length("address") BETWEEN 3 AND 320 AND position('@' in "address") > 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mailbox_addresses_primary_idx" ON "mailbox_addresses" ("mailbox_id") WHERE "is_primary";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mailbox_addresses_mailbox_idx" ON "mailbox_addresses" ("mailbox_id");
--> statement-breakpoint
-- One mail as it sits in one mailbox (the same mail to two mailboxes is two rows).
-- Raw MIME stays in the company's S3 bucket (raw_s3_key); attachments come in S3.
CREATE TABLE IF NOT EXISTS "inbox_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mailbox_id" uuid NOT NULL REFERENCES "mailboxes"("id") ON DELETE CASCADE,
	"folder" text NOT NULL,
	"thread_id" uuid NOT NULL,
	"message_id" text,
	"ses_message_id" text,
	"in_reply_to" text,
	"references" text[] DEFAULT '{}'::text[] NOT NULL,
	"from" jsonb NOT NULL,
	"to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text NOT NULL,
	"snippet" text NOT NULL,
	"text_body" text,
	"html_body" text,
	"received_at" timestamp with time zone NOT NULL,
	"read_at" timestamp with time zone,
	"starred" boolean DEFAULT false NOT NULL,
	"verdicts" jsonb,
	"raw_s3_key" text,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_messages_folder_check" CHECK ("folder" IN ('inbox', 'sent', 'spam', 'trash', 'archive')),
	CONSTRAINT "inbox_messages_size_check" CHECK ("size_bytes" >= 0)
);
--> statement-breakpoint
-- SNS retries deliver the same receipt again: one row per mailbox per SES message.
CREATE UNIQUE INDEX IF NOT EXISTS "inbox_messages_ses_idx" ON "inbox_messages" ("mailbox_id", "ses_message_id") WHERE "ses_message_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbox_messages_folder_idx" ON "inbox_messages" ("mailbox_id", "folder", "received_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbox_messages_thread_idx" ON "inbox_messages" ("mailbox_id", "thread_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbox_messages_message_id_idx" ON "inbox_messages" ("mailbox_id", "message_id") WHERE "message_id" IS NOT NULL;
