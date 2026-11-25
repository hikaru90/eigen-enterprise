import { z } from 'zod'
import { KernelError } from '$lib/kernel/errors'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import type { QuestionActor, TeamQuestionDeps, TeamQuestionView } from '$lib/server/memory/team-questions/service'
import { liveMemoryWriterOf, requireWriter, type MemoryWriter } from './assistant-writes'
import { QUESTION_TOOL_NAMES } from './manifest'

/**
 * questions.* kernel tools (namespace owned by the memory module): team
 * questions (Contribute 057cd4d5) — a member puts a short question to the
 * whole company or to chosen groups and people, with free tags; the audience
 * reads it in Memory › Questions and answers it there (not the chat). Who acts
 * is resolved like Memory writes (assistant-writes.ts): a person acts as
 * themself, the company assistant for the person it is answering, or the call
 * fails loud. Not approval-gated: the person asked for it, and it only lands
 * with colleagues inside the company (like tasks.assign).
 */

export { QUESTION_TOOL_NAMES }

export type QuestionToolDeps = {
  deps?: () => Promise<TeamQuestionDeps>
  writerOf?: (ctx: ToolContext) => Promise<MemoryWriter | null>
}

const questionId = z.string().min(1).describe('The question id (from questions.list).')
const emptyInput = z.object({}).strict()
const askInput = z
  .object({
    text: z.string().min(1).max(500).describe('The question, short and crisp — one line people can answer.'),
    tags: z.array(z.string().min(1).max(40)).max(8).optional().describe('Free tags for categories and topics, e.g. ["hr", "travel"]; reuse the ones in questions.tags.'),
    audience: z
      .enum(['company', 'chosen'])
      .optional()
      .describe('company = every member; chosen = the group_ids and person_ids. Leave out: chosen when ids are given, else company.'),
    group_ids: z.array(z.string().min(1)).max(50).optional().describe('Ask these groups (members.group_list).'),
    person_ids: z.array(z.string().min(1)).max(200).optional().describe('Ask these members (members.list), never contacts.'),
  })
  .strict()
const listInput = z
  .object({
    tag: z.string().min(1).max(40).optional().describe('Only questions with this tag.'),
    status: z.enum(['open', 'closed', 'all']).optional().describe('Default all.'),
    for_me: z.boolean().optional().describe('Only open questions asked of the person by someone else that they have not answered yet.'),
  })
  .strict()
const idInput = z.object({ question_id: questionId }).strict()
const answerInput = z.object({ question_id: questionId, text: z.string().min(1).max(4000) }).strict()

async function liveDeps(): Promise<TeamQuestionDeps> {
  const { teamQuestionDeps } = await import('$lib/server/memory/team-questions/live')
  return teamQuestionDeps()
}

const service = () => import('$lib/server/memory/team-questions/service')
const view = (out: unknown) => out as TeamQuestionView | undefined
const short = (text: string) => (text.length <= 80 ? text : `${text.slice(0, 79)}…`)
const audienceLine = (q: TeamQuestionView) =>
  q.audience.kind === 'company' ? 'the company' : [...q.audience.groups.map((g) => g.name), ...q.audience.people.map((p) => p.name)].join(', ')

export function createQuestionTools(opts: QuestionToolDeps = {}): ToolDescriptor[] {
  const deps = opts.deps ?? liveDeps
  const writerOf = opts.writerOf ?? liveMemoryWriterOf
  const actor = async (ctx: ToolContext): Promise<QuestionActor> => {
    const w = requireWriter(await writerOf(ctx))
    return { userId: w.userId, via: w.kind === 'assistant' ? 'assistant' : 'person' }
  }
  const userOf = async (ctx: ToolContext) => (await actor(ctx)).userId
  // Every member's questions (CB3: the brain reaches them as the member).
  const base: Pick<ToolDescriptor, 'module' | 'permission'> = { module: 'memory', permission: { roles: ['admin', 'member', 'agent'] } }

  return [
    {
      ...base,
      name: 'questions.ask',
      summary:
        'Put a short question to colleagues for the person you work for: the whole company (no group_ids / person_ids) or chosen groups and members, with free tags for categories and topics. They read it under Memory › Questions and answer there — it is not a chat message. Use for questions people answer when they can; for work to do use tasks.assign.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof askInput>, output: unknown) => {
        const q = view(output)
        return q ? `${q.author.name} asked ${audienceLine(q)}: ${short(q.text)}` : `Asked: ${short(input.text)}`
      },
      inputSchema: askInput,
      handler: async (ctx, input) => {
        const i = askInput.parse(input)
        const named = (i.group_ids?.length ?? 0) + (i.person_ids?.length ?? 0) > 0
        if (i.audience === 'company' && named) throw new KernelError('invalid_input', 'audience company takes no group_ids or person_ids.')
        const chosen = i.audience ? i.audience === 'chosen' : named
        return (await service()).askQuestion(await deps(), await actor(ctx), {
          text: i.text,
          tags: i.tags ?? [],
          audience: chosen ? { kind: 'chosen', groupIds: i.group_ids ?? [], userIds: i.person_ids ?? [] } : { kind: 'company' },
        })
      },
    },
    {
      ...base,
      name: 'questions.list',
      summary:
        'List the team questions the person can read (asked by them, of the company, of their groups or of them), newest first, with tags, audience, status and answers; filter by tag, status, or for_me (open, asked of them, not answered by them yet).',
      auditClass: 'read',
      inputSchema: listInput,
      handler: async (ctx, input) => {
        const i = listInput.parse(input)
        return (await service()).listQuestions(await deps(), await userOf(ctx), { tag: i.tag, status: i.status, forMe: i.for_me })
      },
    },
    {
      ...base,
      name: 'questions.get',
      summary: 'One team question with its answers (only one the person can read).',
      auditClass: 'read',
      inputSchema: idInput,
      handler: async (ctx, input) => (await service()).getQuestion(await deps(), await userOf(ctx), idInput.parse(input).question_id),
    },
    {
      ...base,
      name: 'questions.answer',
      summary: 'Answer an open team question for the person you work for, on their word; the answer is shown under the question to everyone who can read it.',
      auditClass: 'mutate',
      // The answer itself stays out of the audit line.
      activity: (_input: z.infer<typeof answerInput>, output: unknown) => {
        const q = view(output)
        const author = q?.answers.at(-1)?.author.name
        return q && author ? `${author} answered: ${short(q.text)}` : 'Answered a team question'
      },
      inputSchema: answerInput,
      handler: async (ctx, input) => {
        const i = answerInput.parse(input)
        return (await service()).answerQuestion(await deps(), await actor(ctx), i.question_id, i.text)
      },
    },
    {
      ...base,
      name: 'questions.close',
      summary: 'Close a team question the person asked: it keeps its answers and takes no new ones.',
      auditClass: 'mutate',
      activity: (_input: z.infer<typeof idInput>, output: unknown) => {
        const q = view(output)
        return q ? `${q.author.name} closed the question: ${short(q.text)}` : 'Closed a team question'
      },
      inputSchema: idInput,
      handler: async (ctx, input) => (await service()).closeQuestion(await deps(), await actor(ctx), idInput.parse(input).question_id),
    },
    {
      ...base,
      name: 'questions.tags',
      summary: 'The tags in use on the team questions the person can read, most used first — reuse them when asking.',
      auditClass: 'read',
      inputSchema: emptyInput,
      handler: async (ctx) => (await service()).listQuestionTags(await deps(), await userOf(ctx)),
    },
  ]
}
