-- Answers into the company brain (Contribute 057cd4d5 follow-up): when someone answers a
-- Memory › Question, the question and the answer become one thought in the answerer's brain,
-- linked to the question (thought.team_question_id). The assistant retrieves it like any thought.
--
-- Who reads it: exactly who reads the question (0183) — its asker and its audience (the whole
-- company, or the chosen people and the members of the chosen groups, membership read at the
-- time). Writes stay the owner's (thought_isolation is unchanged). Keys: such a thought is
-- company-sealed (shared-memory-keys.ts thoughtIsSharedSql) so its readers can decrypt it.
-- Deleting the question deletes its answer thoughts (cascade).
--
-- The same policy lives in src/lib/server/db/enable_rls.sql (re-applied after every migrate);
-- the two must stay identical.
ALTER TABLE "thought" ADD COLUMN IF NOT EXISTS "team_question_id" uuid REFERENCES "team_questions"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "thought_team_question_idx" ON "thought" ("team_question_id") WHERE "team_question_id" IS NOT NULL;
--> statement-breakpoint
DROP POLICY IF EXISTS thought_team_question_read ON thought;
--> statement-breakpoint
CREATE POLICY thought_team_question_read ON thought
  FOR SELECT
  USING (
    thought.team_question_id IS NOT NULL
    AND coalesce(current_setting('app.current_user_id', true), '') <> ''
    AND EXISTS (
      SELECT 1 FROM team_questions q
      WHERE q.id = thought.team_question_id
        AND (
          q.author_id = current_setting('app.current_user_id', true)
          OR q.audience_kind = 'company'
          OR current_setting('app.current_user_id', true) = ANY (q.audience_user_ids)
          OR EXISTS (
            SELECT 1 FROM member_group_member gm
            WHERE gm.user_id = current_setting('app.current_user_id', true)
              AND gm.group_id = ANY (q.audience_group_ids)
          )
        )
    )
  );
