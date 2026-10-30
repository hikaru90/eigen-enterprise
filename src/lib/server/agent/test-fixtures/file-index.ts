import type { DurableConversationIndex, DurableConversationRow, RecordDurableConversationInput } from '../conversation-index'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/** Crash tests only: a conversation index that survives the process (JSON file), standing in for Postgres. */
export class FileIndex implements DurableConversationIndex {
  constructor(private readonly path: string) {}
  private rows(): DurableConversationRow[] {
    if (!existsSync(this.path)) return []
    return (JSON.parse(readFileSync(this.path, 'utf8')) as DurableConversationRow[]).map((r) => ({
      ...r,
      createdAt: new Date(r.createdAt),
      updatedAt: new Date(r.updatedAt),
    }))
  }
  async recordConversation(input: RecordDurableConversationInput): Promise<DurableConversationRow> {
    const rows = this.rows()
    const row: DurableConversationRow = {
      ...input,
      runPrincipalId: input.runPrincipalId ?? null,
      runTools: input.runTools ?? null,
      id: rows.length + 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    writeFileSync(this.path, JSON.stringify([...rows, row]))
    return row
  }
  async resolveByConversationKey(key: string) {
    return this.rows().find((r) => r.conversationKey === key)
  }
  async resolveByProviderSession(id: string) {
    return this.rows().find((r) => r.providerSessionId === id)
  }
  async resolveByPiConversationId(id: string) {
    return this.rows().find((r) => r.piConversationId === id)
  }
  async listConversations() {
    return this.rows()
  }
  async touch() {}
}
