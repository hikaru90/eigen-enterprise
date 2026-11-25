import type { DraftDeps, DraftResult } from './handover-upkeep'
import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import type { HandoverActor, HandoverDeps, HandoverEntryView, HandoverView } from '$lib/server/memory/handover/service'
import { HANDOVER_STATUSES } from '$lib/server/memory/handover/store'
import { liveMemoryWriterOf, requireWriter, type MemoryWriter } from './assistant-writes'
import { HANDOVER_TOOL_NAMES } from './manifest'

/**
 * handover.* kernel tools (namespace owned by the memory module; plan/handover.md):
 * a page per person or topic — "Handover to Alex" — one entry per topic with the
 * day, the topic, one sentence, a status and a link to the detail. Every member
 * reads every handover; only its owner writes, as themself or through their
 * assistant (who acts is resolved like Memory writes, assistant-writes.ts).
 * Assigning an entry gives the member an assigned task (Needs you). The brain's
 * upkeep is handover.draft_entry: Jev decides the status, the LLM writes the
 * sentence. Not approval-gated: it stays inside the company, on the owner's word.
 */

export { HANDOVER_TOOL_NAMES }

export type HandoverToolDeps = {
  deps?: () => Promise<HandoverDeps>
  draftDeps?: () => Promise<DraftDeps>
  writerOf?: (ctx: ToolContext) => Promise<MemoryWriter | null>
}

const dayPattern = /^\d{4}-\d{2}-\d{2}$/
const statusEnum = z.enum(HANDOVER_STATUSES).describe('decision_needed, in_progress or for_info.')
const linkField = z.string().max(2000).describe('An app path (/m/…) or an http(s) address of the detail document or item.')
const emptyInput = z.object({}).strict()
const createInput = z
  .object({
    title: z.string().min(1).max(200).describe('e.g. "Handover to Alex" or a topic.'),
    subject_id: z.string().min(1).optional().describe('The member the handover is for (members.list); omit for a topic handover.'),
  })
  .strict()
const getInput = z.object({ handover_id: z.string().min(1) }).strict()
const addInput = z
  .object({
    handover_id: z.string().min(1),
    topic: z.string().min(1).max(120),
    sentence: z.string().min(1).max(400).describe('One sentence: the current state, observed, no evaluation of people.'),
    status: statusEnum,
    link: linkField.optional(),
    entry_on: z.string().regex(dayPattern, 'YYYY-MM-DD').optional().describe('The day the entry speaks for; default today.'),
  })
  .strict()
const updateInput = z
  .object({
    entry_id: z.string().min(1),
    topic: z.string().min(1).max(120).optional(),
    sentence: z.string().min(1).max(400).optional(),
    status: statusEnum.optional(),
    link: linkField.nullable().optional().describe('null or "" removes the link.'),
    entry_on: z.string().regex(dayPattern, 'YYYY-MM-DD').optional().describe('Default: today (a changed entry speaks for the day it changed).'),
  })
  .strict()
const entryInput = z.object({ entry_id: z.string().min(1) }).strict()
const assignInput = z
  .object({ entry_id: z.string().min(1), assignee_id: z.string().min(1).describe('The member id (tasks.assignees), never a contact.') })
  .strict()
const draftInput = z
  .object({
    handover_id: z.string().min(1),
    topic: z.string().min(1).max(120).describe('The entry on this topic is refreshed; a new topic adds an entry.'),
    source: z.string().min(1).max(16_000).describe('What to draft from: the memory item, note, mail or recap text.'),
    link: linkField.optional(),
    status: statusEnum.optional().describe('Only when the person said it; otherwise the decision model decides.'),
  })
  .strict()

async function liveDeps(): Promise<HandoverDeps> {
  const { handoverDeps } = await import('$lib/server/memory/handover/live')
  return handoverDeps()
}
async function liveDraft(): Promise<DraftDeps> {
  const { liveDraftDeps } = await import('./handover-upkeep')
  return liveDraftDeps()
}

const service = () => import('$lib/server/memory/handover/service')
const entryOut = (out: unknown) => out as HandoverEntryView | undefined

export function createHandoverTools(opts: HandoverToolDeps = {}): ToolDescriptor[] {
  const deps = opts.deps ?? liveDeps
  const draftDeps = opts.draftDeps ?? liveDraft
  const writerOf = opts.writerOf ?? liveMemoryWriterOf
  const actor = async (ctx: ToolContext): Promise<HandoverActor> => {
    const w = requireWriter(await writerOf(ctx))
    return { userId: w.userId, via: w.kind === 'assistant' ? 'assistant' : 'person' }
  }
  const base: Pick<ToolDescriptor, 'module' | 'permission'> = { module: 'memory', permission: { roles: ['admin', 'member', 'agent'] } }

  return [
    {
      ...base,
      name: 'handover.create',
      summary:
        'Create a handover page owned by the person you work for: for a member (subject_id, e.g. "Handover to Alex") or a topic. Everyone in the company reads it; only its owner changes it.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof createInput>, output: unknown) => {
        const h = output as HandoverView | undefined
        return h ? `${h.owner.name} started the handover '${h.title}'` : `Started the handover '${input.title}'`
      },
      inputSchema: createInput,
      handler: async (ctx, input) => {
        const i = createInput.parse(input)
        return (await service()).createHandover(await deps(), await actor(ctx), { title: i.title, subjectId: i.subject_id ?? null })
      },
    },
    {
      ...base,
      name: 'handover.list',
      summary: "List the company's handovers (title, owner, who it is for, entry count, decisions needed), most recently changed first. Every member reads them all.",
      auditClass: 'read',
      inputSchema: emptyInput,
      handler: async (ctx) => ({ handovers: await (await service()).listHandovers(await deps(), (await actor(ctx)).userId) }),
    },
    {
      ...base,
      name: 'handover.get',
      summary: 'Read one handover with its entries, newest first: day, topic, one sentence, status (decision_needed / in_progress / for_info), link, assignee.',
      auditClass: 'read',
      inputSchema: getInput,
      handler: async (ctx, input) => (await service()).getHandover(await deps(), (await actor(ctx)).userId, getInput.parse(input).handover_id),
    },
    {
      ...base,
      name: 'handover.add_entry',
      summary:
        'Add an entry to a handover the person you work for owns: a topic, one sentence, a status and an optional link. One entry per topic — for a topic it already has, use handover.update_entry.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof addInput>) => `Added '${input.topic}' to a handover`,
      inputSchema: addInput,
      handler: async (ctx, input) => {
        const i = addInput.parse(input)
        return (await service()).addEntry(await deps(), await actor(ctx), {
          handoverId: i.handover_id,
          topic: i.topic,
          sentence: i.sentence,
          status: i.status,
          link: i.link ?? null,
          entryOn: i.entry_on,
        })
      },
    },
    {
      ...base,
      name: 'handover.update_entry',
      summary: "Change an entry of the person's own handover: topic, sentence, status, link (null removes it) or day. The entry moves to today unless entry_on is given.",
      auditClass: 'mutate',
      activity: (_input: z.infer<typeof updateInput>, output: unknown) => {
        const e = entryOut(output)
        return e ? `Updated '${e.topic}' in a handover` : 'Updated a handover entry'
      },
      inputSchema: updateInput,
      handler: async (ctx, input) => {
        const i = updateInput.parse(input)
        return (await service()).updateEntry(await deps(), await actor(ctx), {
          entryId: i.entry_id,
          topic: i.topic,
          sentence: i.sentence,
          status: i.status,
          link: i.link === undefined ? undefined : i.link || null,
          entryOn: i.entry_on,
        })
      },
    },
    {
      ...base,
      name: 'handover.remove_entry',
      summary: "Remove an entry from the person's own handover. A task it assigned stays with its assignee.",
      auditClass: 'mutate',
      activity: () => 'Removed a handover entry',
      inputSchema: entryInput,
      handler: async (ctx, input) => (await service()).removeEntry(await deps(), await actor(ctx), entryInput.parse(input).entry_id),
    },
    {
      ...base,
      name: 'handover.assign_entry',
      summary:
        "Assign an entry of the person's own handover to another member (tasks.assignees): they get an assigned task from the person — in their Needs you, with the sentence, status and links. Unassigned entries stay information.",
      auditClass: 'mutate',
      activity: (_input: z.infer<typeof assignInput>, output: unknown) => {
        const e = entryOut(output)
        return e?.assignee ? `Assigned '${e.topic}' to ${e.assignee.name}` : 'Assigned a handover entry'
      },
      inputSchema: assignInput,
      handler: async (ctx, input) => {
        const i = assignInput.parse(input)
        return (await service()).assignEntry(await deps(), await actor(ctx), { entryId: i.entry_id, assigneeId: i.assignee_id })
      },
    },
    {
      ...base,
      name: 'handover.draft_entry',
      summary:
        "Keep the person's own handover current from a source you read (a memory item, note, mail, call recap): the entry on that topic is refreshed, or added. The decision model sets the status (unless the person gave one) and the sentence is written for you. When the status is unclear the person is asked in Needs you and the result is pending: draft it again after they answered.",
      auditClass: 'mutate',
      activity: (input: z.infer<typeof draftInput>, output: unknown) => {
        const r = output as DraftResult | undefined
        if (r?.outcome === 'pending') return `Asked about the status of '${input.topic}'`
        return r ? `Refreshed '${input.topic}' in a handover` : `Drafted '${input.topic}'`
      },
      inputSchema: draftInput,
      handler: async (ctx, input) => {
        const i = draftInput.parse(input)
        const who = await actor(ctx)
        const { draftEntry } = await import('./handover-upkeep')
        // The assistant's draft is the brain's upkeep; a person's own call stays theirs.
        return draftEntry(await draftDeps(), { userId: who.userId, via: who.via === 'assistant' ? 'brain' : 'person' }, {
          handoverId: i.handover_id,
          topic: i.topic,
          source: i.source,
          link: i.link ?? null,
          status: i.status,
        })
      },
    },
  ]
}
