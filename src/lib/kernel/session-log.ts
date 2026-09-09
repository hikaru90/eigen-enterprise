/**
 * Durable session memory port (plan/phase-3-one-agent.md M1): the append-only
 * conversation log a loop engine derives its history from. The kernel owns the
 * port and the in-memory implementation; the DB-backed store lives with the
 * other DB kernel stores (db-stores) — this module never imports `$lib/server`.
 * Append-only by convention: no update or delete paths exist anywhere.
 */

export type AgentSessionEventKind = 'user' | 'assistant'

/**
 * One conversation event. The payload carries the message text (e.g.
 * `{ text: "…" }`) — this is the conversation log, so text is the payload;
 * secrets never belong here.
 */
export type AgentSessionEvent = {
  sessionId: string
  agentId: string
  kind: AgentSessionEventKind
  payload: Record<string, unknown>
}

export type AgentSessionLog = {
  append(event: AgentSessionEvent): Promise<void>
  /**
   * The session's events in chronological order (insertion order is the
   * ordering). A limit keeps the LAST n events.
   */
  list(sessionId: string, limit?: number): Promise<AgentSessionEvent[]>
}

/** In-memory AgentSessionLog (tests and engines without a DB backing). */
export class InMemoryAgentSessionLog implements AgentSessionLog {
  private readonly events: AgentSessionEvent[] = []

  async append(event: AgentSessionEvent): Promise<void> {
    this.events.push({ ...event })
  }

  async list(sessionId: string, limit?: number): Promise<AgentSessionEvent[]> {
    const own = this.events.filter((event) => event.sessionId === sessionId)
    const capped = limit === undefined ? own : own.slice(-limit)
    return capped.map((event) => ({ ...event }))
  }
}
