import type { MemoryAuthor } from '$lib/server/db/schema'

/**
 * An AI co-worker's writes in Memory (plan/phase-ai-coworkers.md §7): the
 * thought is its own (thought.user_id = the co-worker) and written by it —
 * author 'agent', its name as the label — so colleagues reading it see who
 * wrote it. Pure (no DB), so kernel tool modules can use it at load time.
 */
export function coworkerAuthorship(name: string): {
  author: MemoryAuthor
  authorLabel: string
  authorKeyId: null
} {
  const label = name.trim()
  if (!label) throw new Error('an AI co-worker writes under its name: the name is empty')
  return { author: 'agent', authorLabel: label, authorKeyId: null }
}

export const COWORKER_WRITES_AS_ITSELF =
  'author and as_user are for API-key callers: an AI co-worker always writes as itself, under its own name.'
