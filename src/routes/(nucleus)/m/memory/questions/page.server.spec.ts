import { describe, expect, it, vi } from 'vitest'
import { KernelError } from '$lib/kernel/errors'
import type { ToolContext } from '$lib/kernel/types'
import { memoryTeamQuestionStore } from '$lib/server/memory/team-questions/memory-store'
import type { TeamQuestionDeps, TeamQuestionView } from '$lib/server/memory/team-questions/service'

const { holder, executed } = vi.hoisted(() => ({
  holder: { deps: null as unknown },
  executed: [] as Array<{
    name: string
    input: unknown
    ctx: { principal: { id: string; kind: string; roles: string[] } }
  }>,
}))

vi.mock('$lib/server/memory/team-questions/live', () => ({
  teamQuestionDeps: async () => holder.deps,
}))
vi.mock('$lib/server/auth/user-role', () => ({
  getUserRole: async (id: string) => (id === 'stranger' ? null : 'member'),
  kernelRolesFor: () => ['member'],
}))
// The registry, reduced to what this page needs: the real questions.* tools, the person as the writer.
vi.mock('$lib/server/boot', async () => {
  const { createQuestionTools } = await import('../../../../../../modules/memory/question-tools')
  const tools = createQuestionTools({
    deps: async () => holder.deps as TeamQuestionDeps,
    writerOf: async (ctx: ToolContext) => ({ kind: 'self', userId: ctx.principal.id }),
  })
  return {
    appKernel: async () => ({
      registry: {
        async execute(name: string, input: unknown, ctx: ToolContext) {
          const tool = tools.find((t) => t.name === name)!
          const parsed = tool.inputSchema.safeParse(input)
          if (!parsed.success)
            throw new KernelError('invalid_input', `invalid input for tool ${name}`)
          executed.push({ name, input, ctx: ctx as (typeof executed)[number]['ctx'] })
          return tool.handler(ctx, parsed.data)
        },
      },
    }),
  }
})

import { actions, load } from './+page.server'

const MEMBERS = [
  { id: 'ony', name: 'Ony' },
  { id: 'alex', name: 'Alex' },
  { id: 'kim', name: 'Kim' },
]

function setup() {
  let t = Date.parse('2026-11-25T09:00:00Z')
  const deps: TeamQuestionDeps = {
    store: memoryTeamQuestionStore(),
    directory: {
      get: async (id) => MEMBERS.find((m) => m.id === id) ?? null,
      list: async () => MEMBERS,
    },
    groups: { list: async () => [{ id: 'g-sales', name: 'Sales', memberIds: ['alex'] }] },
    brain: { rememberAnswer: async () => ({ thoughtId: 't-1' }) },
    now: () => new Date((t += 60_000)),
  }
  holder.deps = deps
  executed.length = 0
  return deps
}

const as = (id: string, search = '') => ({
  locals: { user: { id, name: id } } as unknown as App.Locals,
  url: new URL(`http://x/m/memory/questions${search}`),
})
const post = (id: string, fields: Record<string, string | string[]>) => {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) for (const one of [v].flat()) form.append(k, one)
  return {
    ...as(id),
    request: new Request('http://x/m/memory/questions', { method: 'POST', body: form }),
  }
}
type Ev = Parameters<typeof load>[0]
type ActEv = Parameters<(typeof actions)['ask']>[0]
type Result = {
  questionId?: string
  ok?: true
  status?: number
  data?: { error: string; agent: { attempted: string; tool?: string } }
}
const act = (name: keyof typeof actions, id: string, fields: Record<string, string | string[]>) =>
  actions[name](post(id, fields) as unknown as ActEv) as Promise<Result>
type Loaded = {
  questions: TeamQuestionView[]
  tags: Array<{ tag: string; count: number }>
  audience: { groups: unknown[]; people: unknown[] }
  filter: { tag: string | null; status: string; forMe: boolean }
}
const loaded = async (id: string, search = '') =>
  (await load(as(id, search) as unknown as Ev)) as Loaded

describe('Memory › Questions page', () => {
  it('asks Sales through questions.ask as the signed-in person; Sales sees it open for them, Kim does not', async () => {
    setup()
    expect(
      await act('ask', 'ony', {
        text: 'Who owns the Acme renewal?',
        tags: 'Sales, acme',
        audience: 'chosen',
        group_ids: ['g-sales'],
      }),
    ).toEqual({ questionId: 'new', ok: true })
    expect(executed).toMatchObject([
      {
        name: 'questions.ask',
        input: {
          text: 'Who owns the Acme renewal?',
          tags: ['Sales', 'acme'],
          audience: 'chosen',
          group_ids: ['g-sales'],
          person_ids: [],
        },
        ctx: { principal: { id: 'ony', kind: 'human', roles: ['member'] } },
      },
    ])
    const alex = await loaded('alex', '?for=me')
    expect(alex.filter).toEqual({ tag: null, status: 'open', forMe: true })
    expect(alex.questions).toMatchObject([
      { text: 'Who owns the Acme renewal?', tags: ['sales', 'acme'], forMe: true },
    ])
    expect(alex.tags).toEqual([
      { tag: 'acme', count: 1 },
      { tag: 'sales', count: 1 },
    ])
    expect(alex.audience.groups).toEqual([{ id: 'g-sales', name: 'Sales' }])
    expect((await loaded('kim')).questions).toEqual([])
  })

  it('answers inline, the asker closes; filters by status and tag; refusals come back as messages', async () => {
    setup()
    await act('ask', 'ony', { text: 'Wo liegt das Logo?', tags: 'brand', audience: 'company' })
    const [q] = (await loaded('kim')).questions
    expect(await act('answer', 'kim', { question_id: q.id, text: 'In Drive › Brand.' })).toEqual({
      questionId: q.id,
      ok: true,
    })
    expect((await loaded('kim', '?for=me')).questions).toEqual([])
    const notMine = await act('close', 'kim', { question_id: q.id })
    expect(notMine.status).toBe(403)
    expect(notMine.data?.error).toMatch(/Only the person who asked/)
    expect(notMine.data?.agent).toMatchObject({
      attempted: 'Running questions.close from /m/memory/questions',
      tool: 'questions.close',
    })
    expect(await act('close', 'ony', { question_id: q.id })).toEqual({ questionId: q.id, ok: true })
    expect((await loaded('ony')).questions).toEqual([])
    expect(
      (await loaded('ony', '?status=closed&tag=brand')).questions.map((x) => x.answers.length),
    ).toEqual([1])
    expect((await loaded('ony', '?status=all&tag=other')).questions).toEqual([])
    expect((await act('answer', 'alex', { question_id: q.id, text: 'Late' })).status).toBe(409)
    expect((await act('ask', 'ony', { text: '', audience: 'company' })).status).toBe(400)
    expect((await act('ask', 'ony', { text: 'Q?', audience: 'chosen' })).status).toBe(400)
  })

  it('refuses someone who is no member of the company', async () => {
    setup()
    expect((await act('ask', 'stranger', { text: 'Q?', audience: 'company' })).status).toBe(403)
  })
})
