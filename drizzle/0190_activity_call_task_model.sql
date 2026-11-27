-- AI usage overview (plan/phase-ai-usage-overview.md): each cost row says what the call was for
-- (task, the catalog of src/lib/ai-usage/tasks.ts) and which model answered it. Both are null on
-- rows that are no model call, and on older rows that cannot be matched exactly.
ALTER TABLE "activity_call_log" ADD COLUMN IF NOT EXISTS "task" text;
--> statement-breakpoint
ALTER TABLE "activity_call_log" ADD COLUMN IF NOT EXISTS "model" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_call_log_created_idx" ON "activity_call_log" ("created_at");
--> statement-breakpoint
-- Backfill 1: chat calls that named themselves. The old name sits in `operation`; every value
-- matched here is spelled out in full (name × outcome × attempt), never by pattern. Calls logged
-- as llm.chat.chat.*, agent_iter_* and embeddings named no purpose and stay null.
UPDATE "activity_call_log" AS a
SET "task" = legacy.task
FROM (
  VALUES
    ('assistant_attachment_read', 'assistant.attachment_read'),
    ('orchestrator_brain', 'assistant.turn'),
    ('interpret_thought_preview', 'memory.interpret_preview'),
    ('interpret_thought_preview_category_retry', 'memory.interpret_preview_category_retry'),
    ('enrich_thought_bundle', 'memory.enrich_thought_bundle'),
    ('enrich_thought_bundle_category_retry', 'memory.enrich_category_retry'),
    ('apply_thought_edit', 'memory.apply_thought_edit'),
    ('thought_category', 'memory.thought_category'),
    ('search_cues', 'memory.search_cues'),
    ('timeline_parse_date_range', 'memory.parse_date_range'),
    ('apply_temporal_event_action', 'memory.temporal_event_action'),
    ('compose_answer', 'brain.compose_answer'),
    ('query_intent_classifier', 'brain.query_intent'),
    ('temporal_hint_bindings', 'brain.temporal_hints'),
    ('retrieval_rerank', 'brain.retrieval_rerank'),
    ('delete_search_query', 'brain.delete_search_query'),
    ('delete_target_resolver', 'brain.delete_target'),
    ('community_summary_batch', 'brain.community_summary'),
    ('grounding_next_question', 'brain.grounding_next_question'),
    ('grounding_narrative_synthesis', 'brain.grounding_narrative'),
    ('relevance_checkin_next_question', 'brain.relevance_checkin'),
    ('call_brain_answer', 'calls.brain_answer'),
    ('call_brain_recap', 'calls.brain_recap'),
    ('contacts_extract', 'contacts.extract'),
    ('contacts_next_up', 'contacts.next_up'),
    ('calendar_mail_proposal', 'calendar.mail_proposal'),
    ('handover_sentence', 'handover.sentence'),
    ('repos_summary', 'repos.summary'),
    ('brand_extract', 'branding.extract'),
    ('brand_extract_guide', 'branding.extract_guide'),
    ('brand_social_captions', 'branding.social_captions'),
    ('brand_material_texts', 'branding.material_texts'),
    ('website_page_audience', 'website.page_audience'),
    ('website_app_suggest', 'website.app_suggest'),
    ('app_deploy_diagnose', 'website.app_diagnose'),
    ('drive_archive_suggest', 'drive.archive_suggest'),
    ('contribute_judge', 'contribute.judge'),
    ('contribute_scrub', 'contribute.scrub'),
    ('module_hub_summary', 'contribute.module_summary'),
    ('stt_judge', 'speech.stt_judge')
) AS legacy(name, task),
  (VALUES ('success'), ('error'), ('cut_short')) AS outcome(name),
  (VALUES (1), (2), (3)) AS attempt(n)
WHERE a."task" IS NULL
  AND a."operation" = 'llm.chat.' || legacy.name || '.' || outcome.name || '(attempt=' || attempt.n || ')';
--> statement-breakpoint
-- Backfill 2: the durable agent's turns, one name for two products. The billed principal says
-- which: an AI co-worker's user, or a person (the assistant).
UPDATE "activity_call_log" AS a
SET "task" = CASE WHEN u."kind" = 'coworker' THEN 'coworkers.turn' ELSE 'assistant.turn' END
FROM "user" AS u,
  (VALUES ('success'), ('error'), ('cut_short')) AS outcome(name),
  (VALUES (1), (2), (3)) AS attempt(n)
WHERE a."task" IS NULL
  AND u."id" = a."user_id"
  AND a."operation" = 'llm.chat.durable_agent.' || outcome.name || '(attempt=' || attempt.n || ')';
--> statement-breakpoint
-- Backfill 3: calls whose kind alone is their purpose (the part of `operation` before its
-- parenthesis, compared whole).
UPDATE "activity_call_log" AS a
SET "task" = kind.task
FROM (
  VALUES
    ('llm.stt.success', 'speech.stt'),
    ('llm.stt.error', 'speech.stt'),
    ('llm.tts.success', 'speech.tts'),
    ('llm.tts.error', 'speech.tts'),
    ('llm.decide.success', 'decisions.judge'),
    ('llm.decide.error', 'decisions.judge'),
    ('llm.chat.provider-test.success', 'setup.provider_test'),
    ('llm.chat.provider-test.error', 'setup.provider_test')
) AS kind(operation, task)
WHERE a."task" IS NULL
  AND split_part(a."operation", '(', 1) = kind.operation;
--> statement-breakpoint
-- What a durable conversation's model calls are for. Every dispatch writes it; existing rows get
-- it here so a turn resumed after the upgrade keeps its attribution.
ALTER TABLE "durable_conversations" ADD COLUMN IF NOT EXISTS "task" text;
--> statement-breakpoint
UPDATE "durable_conversations" AS d
SET "task" = CASE WHEN u."kind" = 'coworker' THEN 'coworkers.turn' ELSE 'assistant.turn' END
FROM "user" AS u
WHERE d."task" IS NULL
  AND u."id" = d."llm_user_id";
