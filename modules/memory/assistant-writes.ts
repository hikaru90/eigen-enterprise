import { KernelError } from '$lib/kernel/errors'
import { isViaBrain } from '$lib/kernel/principals'
import type { ToolContext } from '$lib/kernel/types'

/**
 * Who a memory.* write lands with (owner report f8477602, 2026-11-17; CB3):
 * - `self` — the person themselves (signed-in session, or an MCP API key that
 *   belongs to one): it writes as that person;
 * - `assistant` — the company brain acting as the person (a delegated
 *   principal: the principal IS the person, `via: 'brain'`): it writes into
 *   THAT person's Memory. Thoughts it saves are the person's own (they asked;
 *   `capture_source: 'agent'` records it came through the brain); notes it
 *   writes are marked as the assistant's (author 'agent', label
 *   ASSISTANT_AUTHOR_LABEL), and it may change only those.
 * - null — an agent principal that is no person: writes fail loud
 *   (WORKS_FOR_NO_ONE), never as the agent's own id (that id is no user).
 * Reads run as the principal — for the brain, the person: their own Memory,
 * under row-level security, never anyone else's. What assistant writes hand
 * back carries ids and titles, never text.
 */
export type MemoryWriter = { kind: 'self' | 'assistant'; userId: string }

export const ASSISTANT_AUTHOR_LABEL = 'Assistant'

export const WORKS_FOR_NO_ONE =
  'The assistant can write to Memory only while it works for a person (answering them in chat). This run works for no one, so nothing was saved.'

export async function liveMemoryWriterOf(ctx: ToolContext): Promise<MemoryWriter | null> {
  if (isViaBrain(ctx.principal)) return { kind: 'assistant', userId: ctx.principal.id }
  if (ctx.principal.kind === 'human') return { kind: 'self', userId: ctx.principal.id }
  // An agent principal that IS a person (their MCP API key) writes as them.
  const { getUserRole } = await import('$lib/server/auth/user-role')
  return (await getUserRole(ctx.principal.id)) ? { kind: 'self', userId: ctx.principal.id } : null
}

export function requireWriter(writer: MemoryWriter | null): MemoryWriter {
  if (!writer) throw new KernelError('permission_denied', WORKS_FOR_NO_ONE)
  return writer
}

function refuseApiKeyAuthorship(input: { author?: string; as_user?: boolean }): void {
  if (input.author !== undefined || input.as_user !== undefined) {
    throw new Error(
      'author and as_user are for API-key callers; leave them out — what the assistant saves is recorded as coming through the assistant.',
    )
  }
}

/** The assistant saves a thought into the person's Memory (queued for enrichment). */
export async function assistantCaptureThought(
  userId: string,
  input: { raw: string; captured_at?: string; author?: string; as_user?: boolean },
): Promise<{ thoughtId: string; status: 'queued' }> {
  refuseApiKeyAuthorship(input)
  if (!input.raw.trim()) throw new Error('raw is required')
  const { parseOptionalIsoTimestamp } = await import('$lib/server/datetime/parse-iso')
  const capturedAt = parseOptionalIsoTimestamp(input.captured_at, 'captured_at')
  const { queueCapture } = await import('$lib/server/capture/queue-capture')
  const queued = await queueCapture(userId, input.raw, {
    source: 'agent',
    ...(capturedAt ? { capturedAt } : {}),
  })
  return { thoughtId: queued.thoughtId, status: queued.status }
}

/** The assistant writes a note into the person's Memory, marked as its own. */
export async function assistantCreateTextFile(
  userId: string,
  input: { title?: string; body?: string; author?: string; as_user?: boolean },
): Promise<{ textFileId: string; title: string }> {
  refuseApiKeyAuthorship(input)
  if (!(input.title?.trim() || input.body?.trim())) throw new Error('title or body is required')
  const { createTextFile } = await import('$lib/server/text-files/service')
  const note = await createTextFile(userId, {
    title: input.title,
    body: input.body,
    authorship: { author: 'agent', authorLabel: ASSISTANT_AUTHOR_LABEL, authorKeyId: null },
  })
  return { textFileId: note.id, title: note.title }
}

/** The assistant changes a note it wrote; a person's own notes are theirs to change. */
export async function assistantUpdateTextFile(
  userId: string,
  input: { text_file_id: string; title?: string; body?: string },
): Promise<{ textFileId: string; title: string; updatedAt: string }> {
  if (input.title === undefined && input.body === undefined) {
    throw new Error('title or body is required')
  }
  const { getTextFile, updateTextFile } = await import('$lib/server/text-files/service')
  const existing = await getTextFile(userId, input.text_file_id)
  if (!existing) throw new Error('Note not found')
  const writtenByAssistant =
    existing.author === 'agent' &&
    existing.authorKeyId === null &&
    existing.authorLabel === ASSISTANT_AUTHOR_LABEL
  if (!writtenByAssistant) {
    throw new KernelError(
      'permission_denied',
      'That note was not written by the assistant. Only the person changes their own notes — tell them what to change, or write a new note.',
    )
  }
  const note = await updateTextFile(userId, input.text_file_id, {
    title: input.title,
    body: input.body,
  })
  if (!note) throw new Error('Note not found')
  return { textFileId: note.id, title: note.title, updatedAt: note.updatedAt }
}
