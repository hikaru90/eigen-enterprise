-- Brand guide upload (plan/contribute-round-3.md, W7): an extraction session
-- reads either a captured site (source 'url', as before) or an uploaded brand
-- guide (source 'guide'). A guide session has no URL; its PDF/image lives in
-- brand_extraction_guides, base64 in Postgres like the capture screenshot.
-- Existing sessions are all URL sessions (the default).
ALTER TABLE "brand_extraction_sessions" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'url' NOT NULL;
--> statement-breakpoint
ALTER TABLE "brand_extraction_sessions" ALTER COLUMN "url" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "brand_extraction_sessions" DROP CONSTRAINT IF EXISTS "brand_extraction_sessions_source_check";
--> statement-breakpoint
ALTER TABLE "brand_extraction_sessions" ADD CONSTRAINT "brand_extraction_sessions_source_check" CHECK (
	("source" = 'url' AND "url" IS NOT NULL) OR ("source" = 'guide' AND "url" IS NULL)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brand_extraction_guides" (
	"session_id" uuid PRIMARY KEY NOT NULL REFERENCES "brand_extraction_sessions"("id") ON DELETE CASCADE,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"data_b64" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brand_extraction_guides" DROP CONSTRAINT IF EXISTS "brand_extraction_guides_mime_check";
--> statement-breakpoint
ALTER TABLE "brand_extraction_guides" ADD CONSTRAINT "brand_extraction_guides_mime_check" CHECK (
	"mime" IN ('application/pdf', 'image/png', 'image/jpeg', 'image/webp') AND "size_bytes" > 0
);
