-- Email platform, stage 2 (plan/phase-polish-1.md P-6, E-P2): templates and
-- layouts. A layout is the reusable wrapper (header, footer, styles — built from
-- the company's Brand tokens) with one {{content}} slot; a template is a subject
-- + body (MJML or HTML) with {{variables}}, optionally inside a layout. Sends by
-- template id render server-side through the one send path.

CREATE TABLE IF NOT EXISTS "mail_layouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"format" text NOT NULL,
	"body" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_layouts_format_check" CHECK ("format" IN ('mjml', 'html'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"subject" text NOT NULL,
	"format" text NOT NULL,
	"body" text NOT NULL,
	"text_body" text,
	"layout_id" uuid REFERENCES "mail_layouts"("id") ON DELETE RESTRICT,
	"sample_variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_templates_format_check" CHECK ("format" IN ('mjml', 'html'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_templates_layout_idx" ON "mail_templates" ("layout_id");
