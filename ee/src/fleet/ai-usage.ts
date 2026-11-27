import { z } from 'zod'
import { aiUsageDayV1, type AiUsageDayV1 } from './protocol.ts'

const answer = z.object({ rows: z.array(aiUsageDayV1) }).strict()

/** os's /api/fleet/ai-usage answer as protocol rows; anything else throws (naming the field, never echoing values). */
export function aiUsageRowsFromOs(body: unknown): AiUsageDayV1[] {
  const parsed = answer.safeParse(body)
  if (!parsed.success) {
    const where = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(body)'))].slice(0, 5).join(', ')
    throw new Error(`os answered /api/fleet/ai-usage without valid usage rows (${where})`)
  }
  return parsed.data.rows
}
