import type {
  CaptureMemoryAuthor,
  CaptureSubmitResult,
  CaptureThoughtSource,
} from '$lib/capture/capture-result-types'
import { m } from '$lib/paraglide/messages.js'

/**
 * Memory › What the brain knows (plan/concept-memory-one-door.md §2.2): for
 * each thought the brain took in, where it came from and whether it is
 * indexed yet. Both are read straight off the stored row (capture_source,
 * author, enrich queue state) — structure, no model. Shared by the page and
 * the memory.list_thoughts registry tool, so the CLI and the agent see what
 * the person sees.
 */

/** How many of the newest thoughts the page (and memory.list_thoughts by default) shows. */
export const BRAIN_KNOWS_LIMIT = 30

/** The page re-reads the list this often, so what the assistant files shows up while it is open. */
export const BRAIN_KNOWS_POLL_MS = 5_000

/** Where a thought came from, as far as the row records it. */
export type BrainKnowsSource =
  | { kind: 'app_input' }
  | { kind: 'assistant' }
  | { kind: 'connected_agent'; name: string | null }
  | { kind: 'cli_or_mcp' }
  | { kind: 'app' }
  | { kind: 'evaluation' }
  | { kind: 'unrecorded' }

export function brainKnowsSource(row: {
  source: CaptureThoughtSource | null
  author: CaptureMemoryAuthor
  authorLabel?: string | null
}): BrainKnowsSource {
  if (row.author === 'agent') return { kind: 'connected_agent', name: row.authorLabel ?? null }
  switch (row.source) {
    case 'ui':
      return { kind: 'app_input' }
    case 'agent':
      // capture_source 'agent' with the person as author: the company brain saved it for them.
      return { kind: 'assistant' }
    case 'mcp':
      return { kind: 'cli_or_mcp' }
    case 'api':
      return { kind: 'app' }
    case 'eval':
      return { kind: 'evaluation' }
    case null:
      return { kind: 'unrecorded' }
  }
}

export function brainKnowsSourceLabel(source: BrainKnowsSource): string {
  switch (source.kind) {
    case 'app_input':
      return m.memory_knows_source_ui()
    case 'assistant':
      return m.memory_knows_source_assistant()
    case 'connected_agent':
      return source.name
        ? m.memory_knows_source_agent({ name: source.name })
        : m.memory_knows_source_agent_unnamed()
    case 'cli_or_mcp':
      return m.memory_knows_source_mcp()
    case 'app':
      return m.memory_knows_source_api()
    case 'evaluation':
      return m.memory_knows_source_eval()
    case 'unrecorded':
      return m.memory_knows_source_unknown()
  }
}

/** indexed · pending (waiting) · indexing (the worker has it) · failed (Retry). */
export type BrainKnowsIndexState = 'indexed' | 'pending' | 'indexing' | 'failed'

export function brainKnowsIndexState(
  detail: Pick<CaptureSubmitResult, 'enrichmentComplete' | 'queueStatus'>,
): BrainKnowsIndexState {
  if (detail.enrichmentComplete) return 'indexed'
  // 'complete' without enrichment: the job ended but the links/embedding are missing.
  if (detail.queueStatus === 'failed' || detail.queueStatus === 'complete') return 'failed'
  if (detail.queueStatus === 'processing') return 'indexing'
  return 'pending'
}

export function brainKnowsIndexLabel(state: BrainKnowsIndexState): string {
  switch (state) {
    case 'indexed':
      return m.memory_knows_status_indexed()
    case 'pending':
      return m.memory_knows_status_pending()
    case 'indexing':
      return m.memory_knows_status_indexing()
    case 'failed':
      return m.memory_knows_status_failed()
  }
}
