CREATE TABLE IF NOT EXISTS "kernel_gateway_allowlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"external_user_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kernel_gateway_allowlist_platform_external_user_id_unique" UNIQUE("platform","external_user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kernel_gateway_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"external_chat_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kernel_gateway_sessions_platform_external_chat_id_unique" UNIQUE("platform","external_chat_id")
);
