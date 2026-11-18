-- Brand › Social (Contribute 6ff283ef): the company's social media posts in
-- its style. A post is a branded graphic (drawn live from the active visual
-- set at a social aspect ratio; the copy is kept here) or uploaded media
-- (images for a post or a carousel, or one video), with one caption per
-- target network, a status and an optional planned day. The media bytes live
-- content-addressed on disk next to the Drive (<drive dir>/brand-social);
-- this table keeps their metadata. Company-level tables (no RLS), like the
-- other brand_* tables: every member works on the company's posts.

CREATE TABLE IF NOT EXISTS "brand_social_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"source" text NOT NULL,
	"format" text,
	"graphic" jsonb,
	"networks" jsonb NOT NULL,
	"captions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"planned_for" date,
	"created_by" text NOT NULL,
	"created_by_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_social_posts_title_check" CHECK (length(btrim("title")) BETWEEN 1 AND 120),
	CONSTRAINT "brand_social_posts_source_check" CHECK ("source" IN ('graphic', 'upload')),
	CONSTRAINT "brand_social_posts_format_check" CHECK ("format" IS NULL OR "format" IN ('square', 'portrait', 'story', 'landscape')),
	CONSTRAINT "brand_social_posts_graphic_check" CHECK (
		("source" = 'graphic' AND "format" IS NOT NULL AND "graphic" IS NOT NULL)
		OR ("source" = 'upload' AND "format" IS NULL AND "graphic" IS NULL)
	),
	CONSTRAINT "brand_social_posts_networks_check" CHECK (jsonb_typeof("networks") = 'array' AND jsonb_array_length("networks") >= 1),
	CONSTRAINT "brand_social_posts_captions_check" CHECK (jsonb_typeof("captions") = 'object'),
	CONSTRAINT "brand_social_posts_status_check" CHECK ("status" IN ('draft', 'ready', 'posted')),
	CONSTRAINT "brand_social_posts_created_by_kind_check" CHECK ("created_by_kind" IN ('user', 'agent'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brand_social_posts_created_idx" ON "brand_social_posts" ("created_at" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brand_social_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL REFERENCES "brand_social_posts"("id") ON DELETE CASCADE,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_social_media_position_unique" UNIQUE ("post_id", "position"),
	CONSTRAINT "brand_social_media_sha_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "brand_social_media_size_check" CHECK ("size" > 0),
	CONSTRAINT "brand_social_media_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 255)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brand_social_media_sha_idx" ON "brand_social_media" ("sha256");
