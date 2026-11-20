import { eq, isNull, and } from 'drizzle-orm'
import { getDb } from '$lib/server/db'
import { companyAi } from '$lib/server/db/company.schema'
import { assertPoolModel, type ChoosableSlot } from './model-pool'

/**
 * The company's AI settings (migration 0160): the "Use eigenInference" switch, the model each
 * choosable slot holds (null = the pool's pick), and the install's fixed embedding model (null
 * until the first resolution pins it). One row; a missing row is a broken migration, never
 * "no settings".
 */
export type CompanyAiSettings = {
  useEigenInference: boolean
  picks: Record<ChoosableSlot, string | null>
  embeddingModel: string | null
}

const ROW = 'company'

const PICK_COLUMN = {
  chat: 'chatModel',
  stt: 'sttModel',
  tts: 'ttsModel',
  decision: 'decisionModel',
} as const satisfies Record<ChoosableSlot, keyof typeof companyAi.$inferSelect>

export type CompanyAiStore = {
  read(): Promise<CompanyAiSettings>
  setUseEigenInference(on: boolean, by: string): Promise<void>
  /** null = back to the pool's pick. A model outside the pool for the slot throws. */
  setPick(slot: ChoosableSlot, model: string | null, by: string): Promise<void>
  /** Sets the embedding model if none is set yet; returns the one stored (first writer wins). */
  pinEmbeddingModel(model: string): Promise<string>
}

export function companyAiStore(): CompanyAiStore {
  return {
    async read() {
      const [row] = await getDb().select().from(companyAi).where(eq(companyAi.id, ROW)).limit(1)
      if (!row) {
        throw new Error('The company AI settings row is missing (migration 0160_company_ai did not run).')
      }
      return {
        useEigenInference: row.useEigenInference,
        picks: {
          chat: row.chatModel,
          stt: row.sttModel,
          tts: row.ttsModel,
          decision: row.decisionModel,
        },
        embeddingModel: row.embeddingModel,
      }
    },

    async setUseEigenInference(on, by) {
      const updated = await getDb()
        .update(companyAi)
        .set({ useEigenInference: on, updatedBy: by, updatedAt: new Date() })
        .where(eq(companyAi.id, ROW))
        .returning({ id: companyAi.id })
      if (updated.length !== 1) throw new Error('The company AI settings row is missing (migration 0160_company_ai did not run).')
    },

    async setPick(slot, model, by) {
      if (model !== null) assertPoolModel(slot, model)
      const updated = await getDb()
        .update(companyAi)
        .set({ [PICK_COLUMN[slot]]: model, updatedBy: by, updatedAt: new Date() })
        .where(eq(companyAi.id, ROW))
        .returning({ id: companyAi.id })
      if (updated.length !== 1) throw new Error('The company AI settings row is missing (migration 0160_company_ai did not run).')
    },

    async pinEmbeddingModel(model) {
      assertPoolModel('embedding', model)
      await getDb()
        .update(companyAi)
        .set({ embeddingModel: model, updatedBy: 'system:embedding-pin', updatedAt: new Date() })
        .where(and(eq(companyAi.id, ROW), isNull(companyAi.embeddingModel)))
      const [row] = await getDb()
        .select({ embeddingModel: companyAi.embeddingModel })
        .from(companyAi)
        .where(eq(companyAi.id, ROW))
        .limit(1)
      if (!row?.embeddingModel) {
        throw new Error('The company AI settings row is missing (migration 0160_company_ai did not run).')
      }
      return row.embeddingModel
    },
  }
}
