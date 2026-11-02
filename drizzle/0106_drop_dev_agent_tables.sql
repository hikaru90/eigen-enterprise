-- S1 removals (plan/phase-software-factory.md §6, announced): the dev-agent
-- module and the AgentSessionLog port are deleted, so their tables go too.
--
-- kernel_agent_session_events: AgentSessionLog's append-only conversation log
-- (migration 0078). No writer since 2026-10-20 — the durable engine keeps its
-- history in pi-durable storage.
-- kernel_devagent_runs: the dev-agent module's run rows (migration 0073), only
-- ever read/written by modules/orchestrator/dev-agent (deleted).
DROP TABLE IF EXISTS kernel_agent_session_events;
DROP TABLE IF EXISTS kernel_devagent_runs;
