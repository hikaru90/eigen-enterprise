-- Company journeys — durable state for declarative conversation journeys
-- (kernel primitive: src/lib/kernel/playbook.ts; driver: the orchestrator's
-- journey-aware runtime). `state` is the JSONB JourneyState (collected answers,
-- captured steps, artifact ledger); `kind` selects the JourneySpec.

CREATE TABLE IF NOT EXISTS "kernel_journeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kernel_journeys_status_check" CHECK ("kernel_journeys"."status" in ('active', 'completed', 'abandoned'))
);
--> statement-breakpoint
-- One ACTIVE journey per kind: a second founding journey must fail loud
-- (unique violation on create), never silently coexist with an open one.
CREATE UNIQUE INDEX IF NOT EXISTS "kernel_journeys_one_active_per_kind_idx"
	ON "kernel_journeys" ("kind") WHERE "kernel_journeys"."status" = 'active';
