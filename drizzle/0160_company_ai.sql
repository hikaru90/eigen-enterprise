-- eigenInference and the model slots (plan/phase-company-brain.md §6, CB1).
-- One row per company: the "Use eigenInference" switch and the model each role
-- slot runs on. chat / stt / tts / decision are picked in Settings → AI from the
-- curated pool (src/lib/server/llm/model-pool.ts); NULL = the pool's pick.
-- embedding is fixed per install: set once, on the first resolution, never
-- through Settings (changing it means re-indexing every vector).
-- Company-level table (no RLS): the AI provider is the company's, whoever
-- triggers a call; the capability guard decides who may change it.
--
-- Upgrade: the switch starts OFF where the company already runs on its own key
-- (the owner's billing mode is byok), ON everywhere else.

CREATE TABLE IF NOT EXISTS "company_ai" (
	"id" text PRIMARY KEY DEFAULT 'company' NOT NULL,
	"use_eigen_inference" boolean NOT NULL,
	"chat_model" text,
	"stt_model" text,
	"tts_model" text,
	"decision_model" text,
	"embedding_model" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_ai_singleton" CHECK ("id" = 'company')
);
--> statement-breakpoint
INSERT INTO "company_ai" ("id", "use_eigen_inference", "updated_by")
SELECT 'company',
	NOT EXISTS (
		SELECT 1 FROM "user_preference" p
		JOIN "user" u ON u."id" = p."user_id"
		WHERE u."role" = 'owner' AND p."billing_mode" = 'byok'
	),
	'migration:0160_company_ai'
ON CONFLICT ("id") DO NOTHING;
