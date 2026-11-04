-- Email platform, stage 3 (plan/phase-polish-1.md P-6, E-P3): contact lists
-- (Owlery's contact books) with subscribe / unsubscribe / double opt-in, and
-- flows (automations): a list trigger, then wait + send-template steps, run per
-- contact (enrollments) by the email module's background jobs, with an
-- execution log.

CREATE TABLE IF NOT EXISTS "mail_contact_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"double_opt_in" boolean DEFAULT false NOT NULL,
	"public_signup" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL REFERENCES "mail_contact_lists"("id") ON DELETE CASCADE,
	"email" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"unsubscribe_reason" text,
	"token" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_contacts_token_unique" UNIQUE("token"),
	CONSTRAINT "mail_contacts_status_check" CHECK ("status" IN ('pending', 'subscribed', 'unsubscribed')),
	CONSTRAINT "mail_contacts_reason_check" CHECK ("unsubscribe_reason" IS NULL OR "unsubscribe_reason" IN ('UNSUBSCRIBED', 'BOUNCED', 'COMPLAINED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_contacts_list_email_idx" ON "mail_contacts" ("list_id", "email");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_contacts_email_idx" ON "mail_contacts" ("email");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"trigger_list_id" uuid REFERENCES "mail_contact_lists"("id") ON DELETE SET NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_flows_status_check" CHECK ("status" IN ('draft', 'active', 'paused'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_flow_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flow_id" uuid NOT NULL REFERENCES "mail_flows"("id") ON DELETE CASCADE,
	"contact_id" uuid NOT NULL REFERENCES "mail_contacts"("id") ON DELETE CASCADE,
	"status" text DEFAULT 'active' NOT NULL,
	"step_index" integer DEFAULT 0 NOT NULL,
	"wait_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_flow_enrollments_status_check" CHECK ("status" IN ('active', 'completed', 'exited'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_flow_enrollments_once_idx" ON "mail_flow_enrollments" ("flow_id", "contact_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_flow_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flow_id" uuid NOT NULL REFERENCES "mail_flows"("id") ON DELETE CASCADE,
	"enrollment_id" uuid NOT NULL REFERENCES "mail_flow_enrollments"("id") ON DELETE CASCADE,
	"step_id" text,
	"event" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_flow_log_flow_idx" ON "mail_flow_log" ("flow_id", "created_at");
