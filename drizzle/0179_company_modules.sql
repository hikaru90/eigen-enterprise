-- U2 stream A (plan/phase-upgrades-u2.md §4.6, §6.6, §8): the company's own modules.
--
-- kernel_modules: one row per module of this box — its box-side owner (the person
-- who scaffolded it; a background call acts as them), the deployed manifest,
-- receipt, commit and bundle, and the kernel's view of where it stands
-- (unpublished | publishing | deploying | connecting | running | failed | off)
-- with the sentence on why it is failed or off. A person's intent stays in
-- kernel_module_activations (module id x-<id>); a module is on when that is true
-- and this says running. pending_deploy: a deploy that waits for an admin's own
-- click (D13), until one deploys.
--
-- kernel_module_versions: every receipted (published) commit, with its receipt.
--
-- kernel_module_event_cursor: event delivery per module (§4.4): the last event
-- delivered and acked (kernel_events ts + id), the head event's failed attempts
-- and when to try it again; after 24 h it is dropped with a journal line.
--
-- kernel_module_sharing: the owner's one-time OK that modules built here are open
-- source (Apache-2.0) and shared with eigenEnterprise (§6.6): one row, id 'company'.
CREATE TABLE IF NOT EXISTS "kernel_modules" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_user_id" text NOT NULL,
  "manifest" jsonb,
  "receipt" jsonb,
  "commit" text,
  "bundle_sha256" text,
  "state" text NOT NULL,
  "reason" text,
  "state_since" timestamp with time zone NOT NULL,
  "first_deployed_at" timestamp with time zone,
  "deployed_from" text,
  "deployed_by" text,
  "pending_deploy" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "kernel_modules_state_check" CHECK ("state" IN ('unpublished', 'publishing', 'deploying', 'connecting', 'running', 'failed', 'off')),
  CONSTRAINT "kernel_modules_deployed_from_check" CHECK ("deployed_from" IS NULL OR "deployed_from" IN ('unpublished', 'publishing', 'deploying', 'connecting', 'running', 'failed', 'off')),
  CONSTRAINT "kernel_modules_commit_check" CHECK ("commit" IS NULL OR "commit" ~ '^[0-9a-f]{40}$')
);

CREATE TABLE IF NOT EXISTS "kernel_module_versions" (
  "module_id" text NOT NULL,
  "commit" text NOT NULL,
  "version" text NOT NULL,
  "bundle_sha256" text NOT NULL,
  "manifest" jsonb NOT NULL,
  "receipt" jsonb NOT NULL,
  "published_at" timestamp with time zone NOT NULL,
  CONSTRAINT "kernel_module_versions_pk" PRIMARY KEY ("module_id", "commit")
);

CREATE TABLE IF NOT EXISTS "kernel_module_event_cursor" (
  "module_id" text PRIMARY KEY NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "last_ts" timestamp with time zone,
  "last_id" uuid,
  "attempts" integer DEFAULT 0 NOT NULL,
  "failing_since" timestamp with time zone,
  "next_attempt_at" timestamp with time zone
);

CREATE TABLE IF NOT EXISTS "kernel_module_sharing" (
  "id" text PRIMARY KEY DEFAULT 'company' NOT NULL,
  "accepted_by" text NOT NULL,
  "accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "kernel_module_sharing_one_row" CHECK ("id" = 'company')
);

-- Event delivery reads kernel_events by type in (ts, id) order.
CREATE INDEX IF NOT EXISTS "kernel_events_type_ts_id_idx" ON "kernel_events" ("type", "ts", "id");
