-- Durable append-only agent session log (phase-3 M1, one-agent loop): the
-- builtin-json engine derives per-session conversation history from this table
-- (port: src/lib/kernel/session-log.ts, DB store: src/lib/kernel/db-stores.ts)
-- so conversations survive engine/process restarts. Append-only by convention:
-- no UPDATE/DELETE paths exist in code; bigserial id is the global ordering.

CREATE TABLE IF NOT EXISTS kernel_agent_session_events (
  id bigserial PRIMARY KEY,
  session_id text NOT NULL,
  agent_id text NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- App-level CHECK constraint (repo idiom, see 0075/0076): survives dump/restore
-- better than enum churn.
ALTER TABLE kernel_agent_session_events
  DROP CONSTRAINT IF EXISTS kernel_agent_session_events_kind_check;
ALTER TABLE kernel_agent_session_events
  ADD CONSTRAINT kernel_agent_session_events_kind_check CHECK (kind IN ('user', 'assistant'));

CREATE INDEX IF NOT EXISTS kernel_agent_session_events_session_idx
  ON kernel_agent_session_events (session_id, id);
