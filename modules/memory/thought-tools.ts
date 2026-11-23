import { z } from 'zod'
import { KernelError } from '$lib/kernel/errors'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { ASSISTANT_AUTHOR_LABEL, liveMemoryWriterOf, requireWriter, type MemoryWriter } from './assistant-writes'
import { THOUGHT_TOOL_NAMES } from './manifest'

/**
 * Thoughts, entities, the graph, notes-on-thoughts and connected external agents as
 * registry tools (UI parity, ui-parity.ts): each runs the SAME service function the
 * Memory UI's route runs, as the person (assistant-writes.ts: a person acts as themself,
 * the company assistant for the person it answers, in THEIR Memory, or fails loud).
 * Everything here is the person's own Memory, so nothing goes on the approval list
 * (approvals are the owner's; a member's private Memory is not — see own-task-tools.ts).
 * For-good deletions declare approvalRisk 'destructive' and tell the agent to confirm.
 * A note the assistant deletes must be one it wrote (like memory.update_text_file).
 * Activity lines never carry Memory's words.
 */

export { THOUGHT_TOOL_NAMES }

type Ok<T = object> = ({ ok: true } & T) | { ok: false }
type NoteAuthorship = { editable: boolean; author: string; authorKeyId: string | null; authorLabel: string | null }

/** The service calls the routes make (live: liveThoughtToolService). */
export type ThoughtToolService = {
  editThought(userId: string, thoughtId: string, change: string): Promise<Ok<{ thought: unknown }>>
  setThoughtStatus(userId: string, thoughtId: string, status: 'open' | 'completed' | 'archived'): Promise<Ok<{ thought: unknown }>>
  deleteThought(
    userId: string,
    thoughtId: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'not_found' } | { ok: false; reason: 'system_project_task'; projectLabel: string }>
  deleteArchivedThoughts(userId: string): Promise<{ deleted: number }>
  retryEnrichment(userId: string, thoughtId: string): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'not_retryable' }>
  relinkThought(userId: string, thoughtId: string): Promise<Ok<{ thought: unknown }>>
  answerRelevance(userId: string, thoughtId: string, action: 'keep' | 'archive'): Promise<{ ok: true; action: string } | { ok: false; reason: string }>
  answerGrounding(userId: string, facetKey: string, answer: string): Promise<void>
  dismissCheckIn(userId: string): Promise<void>
  isGroundingFacetKey(key: string): boolean
  assignProject(userId: string, thoughtId: string, target: { projectEntityId: string } | { projectLabel: string }): Promise<unknown>
  listThoughtNotes(userId: string, thoughtId: string): Promise<unknown[]>
  linkNote(userId: string, thoughtId: string, textFileId: string): Promise<{ linked: boolean; reason?: 'thought_not_found' | 'text_file_not_found' }>
  unlinkNote(userId: string, thoughtId: string, textFileId: string): Promise<boolean>
  getNote(userId: string, textFileId: string): Promise<NoteAuthorship | null>
  deleteNote(userId: string, textFileId: string): Promise<boolean>
  getEntity(userId: string, entityId: string): Promise<unknown | null>
  entityThoughts(userId: string, entityId: string): Promise<unknown[]>
  updateEntity(userId: string, entityId: string, patch: { label?: string; entityType?: string }): Promise<Ok<{ entity: unknown }>>
  deleteEntity(userId: string, entityId: string): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'system_project' }>
  syncEntity(userId: string, entityId: string): Promise<Ok<{ repair: unknown }>>
  cleanUpGraph(userId: string): Promise<unknown>
  listConnectedAgents(userId: string): Promise<unknown[]>
  listAgentProjects(userId: string, agentId: string): Promise<unknown[]>
  assignToAgent(input: { userId: string; agentId: string; thoughtId: string }): Promise<unknown>
  bindAgentProject(input: { userId: string; agentId: string; projectEntityId: string }): Promise<unknown>
  unbindAgentProject(input: { userId: string; agentId: string; projectEntityId: string }): Promise<void>
}

export async function liveThoughtToolService(): Promise<ThoughtToolService> {
  const [capture, queue, lifecycle, del, relevance, profile, due, throttle, consts, assign, notes, entities, repair, graph, agents, agentAssign, trace] =
    await Promise.all([
      import('$lib/server/capture/service'),
      import('$lib/server/capture/queue-capture'),
      import('$lib/server/memory/lifecycle'),
      import('$lib/server/memory/delete-thought'),
      import('$lib/server/grounding/relevance-answer'),
      import('$lib/server/grounding/profile'),
      import('$lib/server/grounding/question-due'),
      import('$lib/server/grounding/push-throttle'),
      import('$lib/server/grounding/constants'),
      import('$lib/server/memory/assign-thought-project'),
      import('$lib/server/text-files/service'),
      import('$lib/server/memory/canonical-entity-admin'),
      import('$lib/server/consolidation/repair-entity-relations'),
      import('$lib/server/graph/run-graph-rearrange'),
      import('$lib/server/agents/service'),
      import('$lib/server/agents/assign-thought'),
      import('$lib/server/activity/trace-context'),
    ])
  const traced = <T>(fn: () => Promise<T>) => trace.runWithTrace(crypto.randomUUID(), fn)
  return {
    editThought: (u, t, change) => traced(() => capture.editStoredThought(u, t, change)) as ReturnType<ThoughtToolService['editThought']>,
    setThoughtStatus: (u, t, s) => traced(() => lifecycle.setThoughtLifecycleStatus(u, t, s)) as ReturnType<ThoughtToolService['setThoughtStatus']>,
    deleteThought: (u, t) => traced(() => del.deleteThoughtForUser(u, t)) as ReturnType<ThoughtToolService['deleteThought']>,
    deleteArchivedThoughts: (u) => del.deleteArchivedThoughtsForUser(u),
    retryEnrichment: (u, t) => queue.requeueEnrichThought(u, t),
    relinkThought: (u, t) => traced(() => capture.relinkThoughtGraph(u, t)) as ReturnType<ThoughtToolService['relinkThought']>,
    answerRelevance: (u, t, action) => relevance.applyRelevanceCheckInAnswer({ userId: u, thoughtId: t, action }),
    answerGrounding: async (u, facetKey, answer) => {
      await profile.saveGroundingQuestionAnswer({ userId: u, facetKey: facetKey as never, answer })
      await throttle.clearPendingCheckIn(u)
    },
    dismissCheckIn: async (u) => {
      await due.touchCheckInQuestionPrompt(u)
      await throttle.clearPendingCheckIn(u)
    },
    isGroundingFacetKey: (k) => consts.GROUNDING_FACET_KEY_SET.has(k),
    assignProject: (u, t, target) => assign.assignThoughtToProject(u, t, target),
    listThoughtNotes: (u, t) => notes.listTextFilesForThought(u, t),
    linkNote: (u, t, n) => notes.linkTextFileToThought(u, t, n),
    unlinkNote: (u, t, n) => notes.unlinkTextFileFromThought(u, t, n),
    getNote: (u, n) => notes.getTextFile(u, n),
    deleteNote: (u, n) => notes.deleteTextFile(u, n),
    getEntity: (u, e) => entities.getCanonicalEntityForUser(u, e),
    entityThoughts: (u, e) => entities.listThoughtsMentioningCanonicalEntity(u, e),
    updateEntity: (u, e, patch) => entities.updateCanonicalEntityForUser(u, e, patch) as ReturnType<ThoughtToolService['updateEntity']>,
    deleteEntity: (u, e) => entities.deleteCanonicalEntityForUser(u, e) as ReturnType<ThoughtToolService['deleteEntity']>,
    syncEntity: async (u, e) => {
      const synced = await entities.syncCanonicalEntityVertexToGraph(u, e)
      if (!synced.ok) return { ok: false }
      return { ok: true, repair: await repair.repairEntityRelationsForUser(u, { batchSize: 40 }) }
    },
    cleanUpGraph: (u) => graph.runGraphRearrangeForUser(u),
    listConnectedAgents: async (u) =>
      (await agents.listConnectedAgents(u)).map((a) => ({
        id: a.id,
        name: a.name,
        enabled: a.enabled,
        subscribedEvents: a.subscribedEvents,
        lastDeliveryAt: a.lastDeliveryAt,
      })),
    listAgentProjects: (u, a) => agents.listAgentProjectBindings(u, a),
    assignToAgent: (input) => agentAssign.assignThoughtToAgent(input),
    bindAgentProject: (input) => agents.bindAgentToProject(input),
    unbindAgentProject: (input) => agents.unbindAgentFromProject(input),
  }
}

export type ThoughtToolDeps = {
  service?: () => Promise<ThoughtToolService>
  writerOf?: (ctx: ToolContext) => Promise<MemoryWriter | null>
}

const NOT_YOURS = 'That thought is not in your Memory (anymore). Find current ids with memory.retrieve_thoughts.'
const ENTITY_NOT_FOUND = 'Entity not found in your Memory.'
const NOTE_NOT_FOUND = 'Note not found. List notes with memory.list_text_files.'

const thoughtId = z.string().min(1).describe('The thought id (memory.retrieve_thoughts).')
const entityId = z.string().min(1).describe('The entity id (memory.retrieve_thoughts / memory.get_entity).')
const textFileId = z.string().min(1).describe('The note id (memory.list_text_files).')
const agentId = z.string().min(1).describe('The connected agent id (memory.list_connected_agents).')
const projectEntityId = z.string().min(1).describe('The project id (memory.list_projects).')

const empty = z.object({}).strict()
const thoughtInput = z.object({ thought_id: thoughtId }).strict()
const editInput = z
  .object({ thought_id: thoughtId, change: z.string().trim().min(1).max(4000).describe('What to change, in plain words; Memory rewrites and re-reads the thought.') })
  .strict()
const statusInput = z.object({ thought_id: thoughtId, status: z.enum(['open', 'completed', 'archived']) }).strict()
const checkInInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('relevance'), thought_id: thoughtId, action: z.enum(['keep', 'archive']) }).strict(),
  z.object({ kind: z.literal('grounding'), facet_key: z.string().min(1), answer: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ kind: z.literal('dismiss') }).strict(),
])
const assignProjectInput = z
  .object({ thought_id: thoughtId, project_entity_id: projectEntityId.optional(), project_label: z.string().trim().min(1).max(200).optional() })
  .strict()
  .refine((i) => !(i.project_entity_id && i.project_label), 'project_entity_id or project_label, not both')
  .refine((i) => i.project_entity_id || i.project_label, 'give project_entity_id or project_label')
const noteLinkInput = z.object({ thought_id: thoughtId, text_file_id: textFileId }).strict()
const noteInput = z.object({ text_file_id: textFileId }).strict()
const entityInput = z.object({ entity_id: entityId }).strict()
const entityUpdateInput = z
  .object({ entity_id: entityId, label: z.string().trim().min(1).max(500).optional(), entity_type: z.string().trim().min(1).max(100).optional() })
  .strict()
  .refine((i) => i.label !== undefined || i.entity_type !== undefined, 'give label or entity_type')
const agentInput = z.object({ agent_id: agentId }).strict()
const agentThoughtInput = z.object({ agent_id: agentId, thought_id: thoughtId }).strict()
const agentProjectInput = z.object({ agent_id: agentId, project_entity_id: projectEntityId }).strict()

export function createThoughtTools(opts: ThoughtToolDeps = {}): ToolDescriptor[] {
  const service = opts.service ?? liveThoughtToolService
  const writerOf = opts.writerOf ?? liveMemoryWriterOf
  const base: Pick<ToolDescriptor, 'module' | 'permission'> = { module: 'memory', permission: { roles: ['admin', 'member', 'agent'] } }

  type Name = (typeof THOUGHT_TOOL_NAMES)[number]
  const def = <S extends z.ZodTypeAny>(
    name: Name,
    summary: string,
    schema: S,
    run: (svc: ThoughtToolService, w: MemoryWriter, input: z.infer<S>) => Promise<unknown>,
    extra: { activity?: string; approvalRisk?: ToolDescriptor['approvalRisk'] } = {},
  ): ToolDescriptor => {
    const { activity, ...rest } = extra
    return {
      ...base,
      name,
      summary,
      auditClass: activity ? 'mutate' : 'read',
      inputSchema: schema,
      ...(activity ? { activity: () => activity } : {}),
      ...rest,
      handler: async (ctx, input) => {
        const parsed = schema.parse(input ?? {})
        const w = requireWriter(await writerOf(ctx))
        try {
          return await run(await service(), w, parsed)
        } catch (err) {
          if (err instanceof KernelError) throw err
          const { isMemoryReadOnlyError } = await import('$lib/server/memory/memory-read-only')
          if (isMemoryReadOnlyError(err)) throw new KernelError('permission_denied', (err as Error).message)
          throw err
        }
      },
    }
  }
  const thoughtOrFail = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
    if (!r.ok) throw new Error(NOT_YOURS)
    return r as Extract<T, { ok: true }>
  }

  return [
    def('memory.edit_thought', 'Edit one of the person’s thoughts (like Memory › Edit): change = what to change in plain words; Memory rewrites, re-enriches and re-links it.', editInput,
      async (s, w, i) => ({ thought: thoughtOrFail(await s.editThought(w.userId, i.thought_id, i.change)).thought }), { activity: 'Edited a thought in Memory' }),
    def('memory.set_thought_status', 'Open, complete or archive one of the person’s thoughts (status: open | completed | archived). Archiving is the undoable way to put a thought away.', statusInput,
      async (s, w, i) => ({ thought: thoughtOrFail(await s.setThoughtStatus(w.userId, i.thought_id, i.status)).thought }), { activity: 'Changed a thought’s status in Memory' }),
    def('memory.delete_thought', 'Delete one of the person’s thoughts for good — text, search index, dates, graph links. It cannot be undone: confirm with the person first; to keep it out of the way, archive it (memory.set_thought_status) instead.', thoughtInput,
      async (s, w, i) => {
        const r = await s.deleteThought(w.userId, i.thought_id)
        if (r.ok) return { deleted: true, thoughtId: i.thought_id }
        if (r.reason === 'system_project_task') throw new KernelError('permission_denied', `This is a task of the company’s “${r.projectLabel}” project: change it there.`)
        throw new Error(NOT_YOURS)
      }, { activity: 'Deleted a thought from Memory', approvalRisk: 'destructive' }),
    def('memory.delete_archived_thoughts', 'Delete ALL of the person’s archived thoughts for good (Memory › Settings › Delete archived). It cannot be undone: confirm with the person first.', empty,
      async (s, w) => s.deleteArchivedThoughts(w.userId), { activity: 'Deleted archived thoughts from Memory', approvalRisk: 'destructive' }),
    def('memory.retry_enrichment', 'Retry the enrichment (categories, dates, links) of a thought whose enrichment failed.', thoughtInput,
      async (s, w, i) => {
        const r = await s.retryEnrichment(w.userId, i.thought_id)
        if (r.ok) return { ok: true, thoughtId: i.thought_id }
        if (r.reason === 'not_found') throw new Error(NOT_YOURS)
        throw new Error('That thought is not eligible for an enrichment retry (it is not failed or is still running).')
      }, { activity: 'Retried a thought’s enrichment' }),
    def('memory.relink_thought', 'Re-link a thought in the person’s graph (re-resolve its entities and relations).', thoughtInput,
      async (s, w, i) => ({ thought: thoughtOrFail(await s.relinkThought(w.userId, i.thought_id)).thought }), { activity: 'Re-linked a thought in the graph' }),
    def('memory.answer_check_in', 'Answer a Memory check-in for the person: kind "relevance" keeps or archives a thought (thought_id, action keep|archive); kind "grounding" answers a profile question (facet_key, answer); kind "dismiss" skips the current check-in.', checkInInput,
      async (s, w, i) => {
        if (i.kind === 'dismiss') {
          await s.dismissCheckIn(w.userId)
          return { kind: 'dismiss', dismissed: true }
        }
        if (i.kind === 'relevance') {
          const r = await s.answerRelevance(w.userId, i.thought_id, i.action)
          if (!r.ok) throw new Error(r.reason === 'not_found' ? NOT_YOURS : 'Invalid action')
          await s.dismissCheckIn(w.userId)
          return { kind: 'relevance', action: r.action }
        }
        if (!s.isGroundingFacetKey(i.facet_key)) throw new Error(`Unknown facet_key "${i.facet_key}".`)
        await s.answerGrounding(w.userId, i.facet_key, i.answer)
        return { kind: 'grounding' }
      }, { activity: 'Answered a Memory check-in' }),
    def('memory.assign_thought_project', 'Put one of the person’s thoughts into a project: project_entity_id (memory.list_projects) or project_label (created when the person has none by that name).', assignProjectInput,
      async (s, w, i) =>
        s.assignProject(w.userId, i.thought_id, i.project_entity_id ? { projectEntityId: i.project_entity_id } : { projectLabel: i.project_label! }),
      { activity: 'Assigned a thought to a project' }),
    def('memory.list_thought_notes', 'List the notes linked to one of the person’s thoughts.', thoughtInput,
      async (s, w, i) => ({ notes: await s.listThoughtNotes(w.userId, i.thought_id) })),
    def('memory.link_text_file', 'Link a note to one of the person’s thoughts.', noteLinkInput,
      async (s, w, i) => {
        const r = await s.linkNote(w.userId, i.thought_id, i.text_file_id)
        if (r.linked) return { linked: true, thoughtId: i.thought_id, textFileId: i.text_file_id }
        throw new Error(r.reason === 'thought_not_found' ? NOT_YOURS : NOTE_NOT_FOUND)
      }, { activity: 'Linked a note to a thought' }),
    def('memory.unlink_text_file', 'Unlink a note from one of the person’s thoughts (the note itself stays).', noteLinkInput,
      async (s, w, i) => {
        if (!(await s.unlinkNote(w.userId, i.thought_id, i.text_file_id))) throw new Error('That note is not linked to that thought.')
        return { unlinked: true, thoughtId: i.thought_id, textFileId: i.text_file_id }
      }, { activity: 'Unlinked a note from a thought' }),
    def('memory.delete_text_file', 'Delete a note for good. A person deletes their own notes; the assistant only notes it wrote itself; a colleague’s shared note is read-only. It cannot be undone: confirm first.', noteInput,
      async (s, w, i) => {
        const note = await s.getNote(w.userId, i.text_file_id)
        if (!note) throw new Error(NOTE_NOT_FOUND)
        if (!note.editable) throw new KernelError('permission_denied', 'That note is a colleague’s, shared read-only. Only its owner deletes it.')
        const byAssistant = note.author === 'agent' && note.authorKeyId === null && note.authorLabel === ASSISTANT_AUTHOR_LABEL
        if (w.kind === 'assistant' && !byAssistant) {
          throw new KernelError('permission_denied', 'That note was not written by the assistant. Only the person deletes their own notes.')
        }
        if (!(await s.deleteNote(w.userId, i.text_file_id))) throw new Error(NOTE_NOT_FOUND)
        return { deleted: true, textFileId: i.text_file_id }
      }, { activity: 'Deleted a note from Memory', approvalRisk: 'destructive' }),
    def('memory.get_entity', 'Read one entity of the person’s graph (label, type) with the thoughts that mention it.', entityInput,
      async (s, w, i) => {
        const entity = await s.getEntity(w.userId, i.entity_id)
        if (!entity) throw new Error(ENTITY_NOT_FOUND)
        return { entity, thoughts: await s.entityThoughts(w.userId, i.entity_id) }
      }),
    def('memory.update_entity', 'Edit an entity of the person’s graph: a new label and/or entity_type.', entityUpdateInput,
      async (s, w, i) => {
        const r = await s.updateEntity(w.userId, i.entity_id, { label: i.label, entityType: i.entity_type })
        if (!r.ok) throw new Error(ENTITY_NOT_FOUND)
        return { entity: r.entity }
      }, { activity: 'Edited an entity in the graph' }),
    def('memory.delete_entity', 'Delete an entity from the person’s graph for good (a company system project cannot be deleted). Confirm with the person first.', entityInput,
      async (s, w, i) => {
        const r = await s.deleteEntity(w.userId, i.entity_id)
        if (r.ok) return { deleted: true, entityId: i.entity_id }
        if (r.reason === 'system_project') throw new KernelError('permission_denied', 'This is a system project of the company and can’t be deleted.')
        throw new Error(ENTITY_NOT_FOUND)
      }, { activity: 'Deleted an entity from the graph', approvalRisk: 'destructive' }),
    def('memory.sync_entity', 'Re-sync an entity and its relations to the person’s graph (then repairs entity relations).', entityInput,
      async (s, w, i) => {
        const r = await s.syncEntity(w.userId, i.entity_id)
        if (!r.ok) throw new Error(ENTITY_NOT_FOUND)
        return { ok: true, repair: r.repair }
      }, { activity: 'Re-synced an entity to the graph' }),
    def('memory.clean_up_graph', 'Clean up the person’s graph: prune weak edges and orphan nodes, repair relations (Graph › Clean up).', empty,
      async (s, w) => s.cleanUpGraph(w.userId), { activity: 'Cleaned up the graph' }),
    def('memory.list_connected_agents', 'List the person’s connected external agents (id, name, enabled, subscribed events).', empty,
      async (s, w) => ({ agents: await s.listConnectedAgents(w.userId) })),
    def('memory.list_agent_projects', 'List the projects a connected external agent is bound to.', agentInput,
      async (s, w, i) => ({ bindings: await s.listAgentProjects(w.userId, i.agent_id) })),
    def('memory.assign_thought_to_agent', 'Hand one of the person’s thoughts to a connected external agent (it is delivered to the agent’s webhook).', agentThoughtInput,
      async (s, w, i) => s.assignToAgent({ userId: w.userId, agentId: i.agent_id, thoughtId: i.thought_id }), { activity: 'Handed a thought to a connected agent' }),
    def('memory.bind_agent_project', 'Bind a connected external agent to one of the person’s projects.', agentProjectInput,
      async (s, w, i) => s.bindAgentProject({ userId: w.userId, agentId: i.agent_id, projectEntityId: i.project_entity_id }), { activity: 'Bound a connected agent to a project' }),
    def('memory.unbind_agent_project', 'Unbind a connected external agent from a project.', agentProjectInput,
      async (s, w, i) => {
        await s.unbindAgentProject({ userId: w.userId, agentId: i.agent_id, projectEntityId: i.project_entity_id })
        return { unbound: true }
      }, { activity: 'Unbound a connected agent from a project' }),
  ]
}
