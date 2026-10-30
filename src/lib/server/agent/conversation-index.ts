import { eq } from 'drizzle-orm'
import type { AppDatabase } from '$lib/server/db'
import { durableConversations, type DurableRunToolRecord } from '$lib/server/db/durable.schema'

export type { DurableRunToolRecord }

/**
 * Postgres index of durable agent conversations (plan/phase-durable.md D7).
 * Postgres keeps the index; pi-durable's SQLite file keeps the transcript. The
 * `provider_session_id` (the pi.provider doc's sessionId) is THE crash-safe
 * attribution key: every gateway model call carries it and resolves back to
 * the `llm_user_id` here, so billing survives process restarts. Per-user
 * secrets never enter the durable SQLite storage.
 */

export type DurableConversationRow = {
  id: number
  conversationKey: string
  agentId: string
  llmUserId: string
  piConversationId: string
  providerSessionId: string
  /** The principal a background run's tools execute as; null for chat conversations. */
  runPrincipalId: string | null
  /** A background run's tool surface; null for chat conversations. */
  runTools: DurableRunToolRecord[] | null
  createdAt: Date
  updatedAt: Date
}

export type RecordDurableConversationInput = {
  /** `<agentId>:<sessionId>` — unique per (agent, chat session). */
  conversationKey: string
  agentId: string
  llmUserId: string
  /** pi-durable conversation id (branded bigint), stored as text. */
  piConversationId: string
  /** The pi.provider doc's sessionId — unique, the attribution key. */
  providerSessionId: string
  /** Background runs only: the principal its tools execute as (chat: omitted). */
  runPrincipalId?: string
  /** Background runs only: the tool surface to re-register on reopen. */
  runTools?: DurableRunToolRecord[]
}

/**
 * The store port the durable engine and the harness composition consume.
 * Implemented by `DbDurableConversationIndex` (Postgres) and
 * `InMemoryDurableConversationIndex` (tests).
 */
export type DurableConversationIndex = {
  recordConversation(
    input: RecordDurableConversationInput,
  ): Promise<DurableConversationRow>
  resolveByConversationKey(conversationKey: string): Promise<DurableConversationRow | undefined>
  resolveByProviderSession(providerSessionId: string): Promise<DurableConversationRow | undefined>
  resolveByPiConversationId(piConversationId: string): Promise<DurableConversationRow | undefined>
  listConversations(): Promise<DurableConversationRow[]>
  /** Stamp `updated_at` (the index has no other mutable column). */
  touch(id: number): Promise<void>
}

function rowOf(record: typeof durableConversations.$inferSelect): DurableConversationRow {
  return {
    id: record.id,
    conversationKey: record.conversationKey,
    agentId: record.agentId,
    llmUserId: record.llmUserId,
    piConversationId: record.piConversationId,
    providerSessionId: record.providerSessionId,
    runPrincipalId: record.runPrincipalId ?? null,
    runTools: record.runTools ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

export class DbDurableConversationIndex implements DurableConversationIndex {
  private readonly db: () => Promise<AppDatabase>

  /**
   * `db` returns the scoped drizzle handle (request-scoped inside the tenant
   * ALS, pooled otherwise) — the same lazy-handle pattern boot.ts uses for the
   * journey store. This table is company-level: no tenant session required.
   */
  constructor(db: () => Promise<AppDatabase>) {
    this.db = db
  }

  async recordConversation(input: RecordDurableConversationInput): Promise<DurableConversationRow> {
    const db = await this.db()
    try {
      const [record] = await db.insert(durableConversations).values(input).returning()
      if (!record) throw new Error('durable_conversations insert returned no row')
      return rowOf(record)
    } catch (err) {
      // Unique conversation_key: a concurrent dispatch of the same session won
      // the insert. Reconcile to the winner's row — both turns continue on ONE
      // pi-durable conversation (its inbox queues them). The loser's
      // created-but-never-submitted pi conversation is inert (no transcript).
      if (err instanceof Error && /durable_conversations_conversation_key_unique/.test(err.message)) {
        console.warn(
          `[durable] conversation key ${input.conversationKey} already recorded — reconciling to the existing row`,
        )
        const existing = await this.resolveByConversationKey(input.conversationKey)
        if (existing) return existing
      }
      throw err
    }
  }

  async resolveByConversationKey(key: string): Promise<DurableConversationRow | undefined> {
    const db = await this.db()
    const [record] = await db
      .select()
      .from(durableConversations)
      .where(eq(durableConversations.conversationKey, key))
      .limit(1)
    return record ? rowOf(record) : undefined
  }

  async resolveByProviderSession(sessionId: string): Promise<DurableConversationRow | undefined> {
    const db = await this.db()
    const [record] = await db
      .select()
      .from(durableConversations)
      .where(eq(durableConversations.providerSessionId, sessionId))
      .limit(1)
    return record ? rowOf(record) : undefined
  }

  async resolveByPiConversationId(piConversationId: string): Promise<DurableConversationRow | undefined> {
    const db = await this.db()
    const [record] = await db
      .select()
      .from(durableConversations)
      .where(eq(durableConversations.piConversationId, piConversationId))
      .limit(1)
    return record ? rowOf(record) : undefined
  }

  async listConversations(): Promise<DurableConversationRow[]> {
    const db = await this.db()
    const records = await db.select().from(durableConversations)
    return records.map(rowOf)
  }

  async touch(id: number): Promise<void> {
    const db = await this.db()
    await db
      .update(durableConversations)
      .set({ updatedAt: new Date() })
      .where(eq(durableConversations.id, id))
  }
}

/** In-memory double (unit tests; the shape DB-backed agents see). */
export class InMemoryDurableConversationIndex implements DurableConversationIndex {
  private readonly rows = new Map<number, DurableConversationRow>()
  private nextId = 1

  async recordConversation(input: RecordDurableConversationInput): Promise<DurableConversationRow> {
    const existing = [...this.rows.values()].find(
      (row) => row.conversationKey === input.conversationKey,
    )
    if (existing) return existing
    const row: DurableConversationRow = {
      id: this.nextId++,
      ...input,
      runPrincipalId: input.runPrincipalId ?? null,
      runTools: input.runTools ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    this.rows.set(row.id, row)
    return row
  }

  async resolveByConversationKey(key: string): Promise<DurableConversationRow | undefined> {
    return [...this.rows.values()].find((row) => row.conversationKey === key)
  }

  async resolveByProviderSession(sessionId: string): Promise<DurableConversationRow | undefined> {
    return [...this.rows.values()].find((row) => row.providerSessionId === sessionId)
  }

  async resolveByPiConversationId(piConversationId: string): Promise<DurableConversationRow | undefined> {
    return [...this.rows.values()].find((row) => row.piConversationId === piConversationId)
  }

  async listConversations(): Promise<DurableConversationRow[]> {
    return [...this.rows.values()].sort((a, b) => a.id - b.id)
  }

  async touch(id: number): Promise<void> {
    const row = this.rows.get(id)
    if (!row) throw new Error(`unknown durable conversation row: ${id}`)
    row.updatedAt = new Date()
  }
}
