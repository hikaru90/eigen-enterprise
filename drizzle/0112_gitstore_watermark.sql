-- Git-native G0 (plan/phase-git-native.md): per-surface index watermark — the
-- data-repo commit each surface's Postgres index was last built from. Boot
-- reconcile rebuilds a surface whose files changed since its watermark.
CREATE TABLE IF NOT EXISTS "gitstore_watermark" (
	"surface" text PRIMARY KEY NOT NULL,
	"commit" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
