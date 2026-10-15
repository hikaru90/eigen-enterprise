-- Extension Roadmap: the company's build log, queue, and plan in one table —
-- rendered under /settings/extensions and managed through the roadmap module's
-- kernel tools (roadmap.add_item / roadmap.update_item). shipped_at is stamped
-- by the store when an item's status becomes 'shipped' and cleared when it
-- leaves that status; the column itself stays dumb.

CREATE TABLE IF NOT EXISTS "extension_roadmap_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"kind" text DEFAULT 'feature' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"shipped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_roadmap_items_status_check" CHECK ("status" IN ('shipped', 'in_progress', 'planned')),
	CONSTRAINT "extension_roadmap_items_kind_check" CHECK ("kind" IN ('feature', 'fix', 'chore'))
);
--> statement-breakpoint
-- Seed roadmap: what customer zero (Kindred Digital Labs) shipped to get here,
-- what is being built now, and what is queued next. Plain INSERTs — visible,
-- reviewable, editable through the kernel tools afterwards.
INSERT INTO "extension_roadmap_items" ("title", "detail", "status", "kind", "position", "shipped_at") VALUES
	('Kernel + module system', 'One registry: permissions, approvals, audit, git auto-commit.', 'shipped', 'feature', 0, '2026-10-15'),
	('Company memory', 'Entities, temporal memory, projects, hybrid retrieval, knowledge graph.', 'shipped', 'feature', 1, '2026-10-15'),
	('Brand pipeline', 'Extract from any URL, judge, select, edit, apply tokens globally.', 'shipped', 'feature', 2, '2026-10-15'),
	('Boot-sequence onboarding', 'Orb, hello, name, one hard provider gate, chat handoff.', 'shipped', 'feature', 3, '2026-10-15'),
	('Founding journey', 'Chat compiles the website: pages created, publishes behind owner approval.', 'shipped', 'feature', 4, '2026-10-15'),
	('Journey hardening', 'Idempotent artifacts + spec versioning: stale interviews abandon themselves.', 'shipped', 'fix', 5, '2026-10-15'),
	('The assistant speaks', 'Gateway TTS (qwen) with honest silence; the browser robot voice is gone.', 'shipped', 'feature', 6, '2026-10-15'),
	('The agent has hands', 'repo + dev-agent modules: worktrees, allowlisted commands, gated merges.', 'shipped', 'feature', 7, '2026-10-15'),
	('Live journey verification', 'The founding journey under e2e against a disposable database.', 'in_progress', 'chore', 0, NULL),
	('One-command deploy', 'curl-to-VPS in under 10 minutes — the wedge''s first promise.', 'planned', 'feature', 0, NULL),
	('Software factory M0', 'Tickets → dev-agent in worktrees → gates → approval-gated merge.', 'planned', 'feature', 1, NULL),
	('Conversation-driven website editing', 'Rename, re-tone, restyle the founded pages by talking.', 'planned', 'feature', 2, NULL),
	('Company templates', 'Pre-configured solo consultancy, e-commerce brand — one click.', 'planned', 'feature', 3, NULL),
	('Voice provider wiring', 'OpenRouter does not serve /audio/speech; pick a speech-capable gateway.', 'planned', 'chore', 4, NULL),
	('Build log from kernel events', 'Derive shipped entries from the audit trail instead of manual rows.', 'planned', 'feature', 5, NULL);
