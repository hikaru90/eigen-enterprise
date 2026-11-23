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
 * - `coworker` — an AI co-worker acting as itself (plan/phase-ai-coworkers.md
 *   §7): it writes into ITS OWN Memory with a member's rights, and what it
 *   captures is recorded as written by it (author 'agent', its name, capture
 *   source 'agent'). Its thoughts are company-visible and read-only to everyone
 *   else (drizzle/0171). A person's own clicks stay theirs: the tools in
 *   COWORKER_REFUSED_TOOLS refuse it, and it never makes anything private.
 * - null — an agent principal that is no person: writes fail loud
 *   (WORKS_FOR_NO_ONE), never as the agent's own id (that id is no user).
 * Reads run as the principal — for the brain, the person: their own Memory,
 * under row-level security, never anyone else's private items. What assistant
 * writes hand back carries ids and titles, never text.
 */
export type MemoryWriter =
  | { kind: 'self' | 'assistant'; userId: string }
  | { kind: 'coworker'; userId: string; name: string }

export const ASSISTANT_AUTHOR_LABEL = 'Assistant'

/** The assistant's leash on visibility (plan/shared-memory-voice-agent-tools.md §1). */
export const ASSISTANT_NEVER_SHARES =
  'The assistant can make a project or note private for the person, but never share it: only the person shares their things (the Private switch in Memory).'

export const WORKS_FOR_NO_ONE =
  'The assistant can write to Memory only while it works for a person (answering them in chat). This run works for no one, so nothing was saved.'

export const COWORKER_OFF =
  'This AI co-worker is switched off or removed, so it does not work in Memory. An admin turns it back on in Settings › Co-workers.'

export async function liveMemoryWriterOf(ctx: ToolContext): Promise<MemoryWriter | null> {
  if (isViaBrain(ctx.principal)) return { kind: 'assistant', userId: ctx.principal.id }
  if (ctx.principal.kind === 'human') return { kind: 'self', userId: ctx.principal.id }
  if (ctx.principal.kind === 'coworker') {
    const { getCoworker } = await import('$lib/server/coworkers')
    const coworker = await getCoworker(ctx.principal.id)
    if (!coworker.enabled || coworker.removedAt !== null) throw new KernelError('permission_denied', COWORKER_OFF)
    return { kind: 'coworker', userId: coworker.id, name: coworker.name }
  }
  // An agent principal that IS a person (their MCP API key) writes as them.
  const { getUserRole } = await import('$lib/server/auth/user-role')
  return (await getUserRole(ctx.principal.id)) ? { kind: 'self', userId: ctx.principal.id } : null
}

export function requireWriter(writer: MemoryWriter | null): MemoryWriter {
  if (!writer) throw new KernelError('permission_denied', WORKS_FOR_NO_ONE)
  return writer
}

const COWORKER_REFUSALS = {
  sharing:
    'An AI co-worker’s projects and notes are always shared with the company; only a person makes their own things private or shares them.',
  check_in: 'Memory check-ins are questions to a person about themselves; an AI co-worker has none to answer.',
  connected_agents: 'Connected external agents are a person’s own integrations; an AI co-worker has none.',
  reminders:
    'Reminders notify a person on their own devices; an AI co-worker has none. Its rhythms are its scheduled check-ins (Settings › Co-workers).',
  private:
    'An AI co-worker works in the open: what it writes is shared with the company, so it cannot make a project or note private.',
  authorship: 'author and as_user are for API-key callers: an AI co-worker always writes as itself, under its own name.',
} as const

/**
 * Memory tools an AI co-worker does not get (plan/phase-ai-coworkers.md §3:
 * "a person's own click" stays human-only). Every other Memory tool it uses
 * like a member, on its own Memory; reads see its own, the other co-workers'
 * thoughts and what colleagues share — never a person's private items.
 */
export const COWORKER_REFUSED_TOOLS: ReadonlyMap<string, keyof typeof COWORKER_REFUSALS> = new Map([
  // Sharing is a person's own click; a co-worker's things are always shared.
  ['memory.set_project_visibility', 'sharing'],
  ['memory.set_text_file_visibility', 'sharing'],
  // Check-ins ask a person about their own life and profile.
  ['memory.answer_check_in', 'check_in'],
  // Connected external agents are a person's own integrations (outbound webhooks).
  ['memory.list_connected_agents', 'connected_agents'],
  ['memory.list_agent_projects', 'connected_agents'],
  ['memory.assign_thought_to_agent', 'connected_agents'],
  ['memory.bind_agent_project', 'connected_agents'],
  ['memory.unbind_agent_project', 'connected_agents'],
  // Reminders notify a person on their devices; a co-worker's rhythms are coworker_rhythm (C6).
  ['reminders.create', 'reminders'],
  ['reminders.list', 'reminders'],
  ['reminders.update', 'reminders'],
  ['reminders.pause', 'reminders'],
  ['reminders.resume', 'reminders'],
  ['reminders.delete', 'reminders'],
  ['reminders.complete', 'reminders'],
  ['reminders.snooze', 'reminders'],
])

/** Inputs that would let a co-worker hide its work (private) or write under another name (author / as_user). */
const PRIVATE_INPUT_TOOLS = new Set(['memory.create_text_file', 'memory.create_project'])
const AUTHORSHIP_INPUT_TOOLS = new Set(['memory.capture_thought', 'memory.create_text_file'])

/** Fails loud when an AI co-worker calls what stays a person's own (COWORKER_REFUSED_TOOLS) or asks for privacy or another name. */
export function refuseForCoworker(toolName: string, input: unknown): void {
  const reason = COWORKER_REFUSED_TOOLS.get(toolName)
  if (reason) throw new KernelError('permission_denied', COWORKER_REFUSALS[reason])
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  if (PRIVATE_INPUT_TOOLS.has(toolName) && body.private === true) {
    throw new KernelError('permission_denied', COWORKER_REFUSALS.private)
  }
  if (AUTHORSHIP_INPUT_TOOLS.has(toolName) && (body.author !== undefined || body.as_user !== undefined)) {
    throw new KernelError('permission_denied', COWORKER_REFUSALS.authorship)
  }
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
  input: { title?: string; body?: string; private?: boolean; author?: string; as_user?: boolean },
): Promise<{ textFileId: string; title: string }> {
  refuseApiKeyAuthorship(input)
  if (!(input.title?.trim() || input.body?.trim())) throw new Error('title or body is required')
  const { createTextFile } = await import('$lib/server/text-files/service')
  const note = await createTextFile(userId, {
    title: input.title,
    body: input.body,
    authorship: { author: 'agent', authorLabel: ASSISTANT_AUTHOR_LABEL, authorKeyId: null },
    // Shared with everyone like any note, unless the person asked for it private.
    visibility: input.private === true ? 'private' : 'company',
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
  if (!existing.editable) {
    throw new KernelError(
      'permission_denied',
      'That note is a colleague’s, shared read-only. Only its owner changes it.',
    )
  }
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
