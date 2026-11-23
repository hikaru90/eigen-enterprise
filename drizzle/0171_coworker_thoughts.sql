-- AI co-workers' thoughts are company-visible (plan/phase-ai-coworkers.md §3, §7, C4).
--
-- A co-worker (a `user` row with kind 'coworker', 0170) works out loud: every signed-in
-- member — a person or another co-worker — may READ its thoughts. Writes stay the owner's:
-- the owner policy thought_isolation (FOR ALL, user_id = the session's user) is unchanged,
-- so only the co-worker itself captures, edits or deletes them. A person's thoughts are
-- untouched: nothing here widens what anyone reads of a human's Memory.
--
-- Derived rows: retrieval reads a co-worker's thought row itself (text, embedding,
-- lexical_text, cues). Its temporal_event rows follow through temporal_event_shared_read
-- (0164: an event whose thought the reader can see). Its entity graph (canonical_entity,
-- thought_entity, communities, neighbours) stays its own.
--
-- Keys: co-worker thoughts are sealed with the company key ("k":"company", 0164) so colleagues
-- can decrypt them: encryptTenantValue seals a co-worker's thought columns with it, and the
-- re-key reconcile (src/lib/server/memory/shared-memory-keys.ts) treats a co-worker's thought
-- as shared, at every write and at server start.
--
-- The same policy lives in src/lib/server/db/enable_rls.sql (re-applied after every migrate);
-- the two must stay identical.
DROP POLICY IF EXISTS thought_coworker_read ON thought;
--> statement-breakpoint
CREATE POLICY thought_coworker_read ON thought
  FOR SELECT
  USING (
    coalesce(current_setting('app.current_user_id', true), '') <> ''
    AND EXISTS (SELECT 1 FROM "user" u WHERE u.id = thought.user_id AND u.kind = 'coworker')
  );
