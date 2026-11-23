import type {
  CaptureRecentThoughtSnippet,
  CaptureSubmitResult,
  CaptureThoughtSource,
} from '$lib/capture/capture-result-types'
import { loadThoughtCaptureResult } from '$lib/server/capture/capture-result'
import { listThoughts } from '$lib/server/capture/service'
import type { CaptureSource, MemoryAuthor } from '$lib/server/db/schema'

// The client's source type and the schema's enum are the same set (compile-time check).
const sameSources: [CaptureSource, CaptureThoughtSource] extends [CaptureThoughtSource, CaptureSource] ? true : never = true
void sameSources

export const RECENT_CAPTURE_THOUGHTS_LIMIT = 8

export type RecentCaptureThoughtsPayload = {
  recentThoughts: CaptureRecentThoughtSnippet[]
  recentThoughtDetails: CaptureSubmitResult[]
}

export type RecentCaptureFilter = {
  author?: MemoryAuthor
  authorLayerKey?: string | null
  category?: string
  dateFrom?: Date
  dateTo?: Date
}

/** Recent thoughts for Memory › What the brain knows, its refresh API and memory.list_thoughts. */
export async function loadRecentCaptureThoughts(
  userId: string,
  limit = RECENT_CAPTURE_THOUGHTS_LIMIT,
  filter?: RecentCaptureFilter,
): Promise<RecentCaptureThoughtsPayload> {
  const recentRows = await listThoughts(userId, {
    fields: 'snippet',
    limit,
    authorFilter: filter?.author,
    authorLayerKey: filter?.authorLayerKey,
    categoryFilter: filter?.category,
    dateFrom: filter?.dateFrom,
    dateTo: filter?.dateTo,
  })
  const recentThoughtDetails = await Promise.all(
    recentRows.map((row) => loadThoughtCaptureResult(userId, row.id)),
  )
  return {
    recentThoughts: recentRows.map((row) => ({
      id: row.id,
      normalizedText: row.normalizedText,
      category: row.category,
      createdAt: row.createdAt.toISOString(),
      author: row.author ?? 'user',
      authorLabel: row.authorLabel ?? null,
      source: row.captureSource ?? null,
      lifecycleStatus: row.lifecycleStatus,
    })),
    recentThoughtDetails,
  }
}
