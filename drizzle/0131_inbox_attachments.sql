-- Attachments of received mail (plan/email-inbox.md S3). Only the metadata
-- lives here: the bytes stay in the raw MIME object in the company's inbound
-- S3 bucket (inbox_messages.raw_s3_key) and are re-read from it on download.
-- part_index is the attachment's position in mailparser's attachment list of
-- that raw object; checksum (md5 of the decoded bytes) proves the part found
-- again is the same one. blocked = SES virus verdict FAIL: never downloadable.
CREATE TABLE IF NOT EXISTS "inbox_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL REFERENCES "inbox_messages"("id") ON DELETE CASCADE,
	"part_index" integer NOT NULL,
	"filename" text,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content_id" text,
	"checksum" text NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_attachments_part_check" CHECK ("part_index" >= 0),
	CONSTRAINT "inbox_attachments_size_check" CHECK ("size_bytes" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inbox_attachments_part_idx" ON "inbox_attachments" ("message_id", "part_index");
