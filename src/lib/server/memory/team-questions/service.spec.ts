import { describe, expect, it } from 'vitest'
import { memoryTeamQuestionStore } from './memory-store'
import {
  answerQuestion,
  askQuestion,
  closeQuestion,
  getQuestion,
  listAudience,
  listQuestions,
  listQuestionTags,
  normaliseTags,
  TeamQuestionError,
  type TeamQuestionDeps,
} from './service'

const MEMBERS = [
  { id: 'ony', name: 'Ony' },
  { id: 'alex', name: 'Alex' },
  { id: 'kim', name: 'Kim' },
  { id: 'sam', name: 'Sam' },
]

function setup() {
  let t = Date.parse('2026-11-25T09:00:00Z')
  let n = 0
  const groups = [
    { id: 'g-sales', name: 'Sales', memberIds: ['alex'] },
    { id: 'g-dev', name: 'Dev', memberIds: ['kim'] },
  ]
  const deps: TeamQuestionDeps = {
    store: memoryTeamQuestionStore(),
    directory: {
      async get(id) {
        return MEMBERS.find((m) => m.id === id) ?? null
      },
      async list() {
        return MEMBERS
      },
    },
    groups: { list: async () => groups },
    now: () => new Date((t += 60_000)),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  }
  return { deps, groups }
}

const person = (userId: string) => ({ userId, via: 'person' as const })

describe('team questions', () => {
  it('asks the whole company: every member reads it, it is open for them until they answer', async () => {
    const { deps } = setup()
    const q = await askQuestion(deps, person('ony'), {
      text: '  Wie buchen wir Reisekosten ab?  ',
      tags: ['Finanzen', '#reisen', 'finanzen'],
      audience: { kind: 'company' },
    })
    expect(q).toMatchObject({
      text: 'Wie buchen wir Reisekosten ab?',
      tags: ['finanzen', 'reisen'],
      audience: { kind: 'company', groups: [], people: [] },
      status: 'open',
      author: { id: 'ony', name: 'Ony' },
      mine: true,
      forMe: false,
      answers: [],
    })
    for (const id of ['alex', 'kim', 'sam']) {
      const [seen] = (await listQuestions(deps, id, { forMe: true })).questions
      expect(seen).toMatchObject({ id: q.id, mine: false, forMe: true })
    }
    const answered = await answerQuestion(deps, person('alex'), q.id, 'Über das Spesenformular in Drive.')
    expect(answered.answers).toMatchObject([{ author: { id: 'alex', name: 'Alex' }, text: 'Über das Spesenformular in Drive.' }])
    expect(answered).toMatchObject({ answeredByMe: true, forMe: false })
    expect((await listQuestions(deps, 'alex', { forMe: true })).questions).toEqual([])
    expect((await listQuestions(deps, 'kim', { forMe: true })).questions).toHaveLength(1)
  })

  it('a question for chosen groups and people is visible to them and the asker only', async () => {
    const { deps } = setup()
    const q = await askQuestion(deps, person('ony'), {
      text: 'Who owns the Acme renewal?',
      tags: ['sales'],
      audience: { kind: 'chosen', groupIds: ['g-sales'], userIds: ['sam'] },
    })
    expect(q.audience).toEqual({ kind: 'chosen', groups: [{ id: 'g-sales', name: 'Sales' }], people: [{ id: 'sam', name: 'Sam' }] })
    expect((await listQuestions(deps, 'alex', {})).questions.map((x) => x.id)).toEqual([q.id])
    expect((await listQuestions(deps, 'sam', {})).questions.map((x) => x.id)).toEqual([q.id])
    expect((await listQuestions(deps, 'ony', {})).questions.map((x) => x.id)).toEqual([q.id])
    expect((await listQuestions(deps, 'kim', {})).questions).toEqual([])
    await expect(getQuestion(deps, 'kim', q.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(answerQuestion(deps, person('kim'), q.id, 'Me?')).rejects.toMatchObject({ code: 'not_found' })
    expect((await listQuestionTags(deps, 'kim')).tags).toEqual([])
  })

  it('group membership is read when the question is read: someone added to the group later sees it', async () => {
    const { deps, groups } = setup()
    const q = await askQuestion(deps, person('ony'), { text: 'Release on Friday?', tags: [], audience: { kind: 'chosen', groupIds: ['g-dev'], userIds: [] } })
    await expect(getQuestion(deps, 'sam', q.id)).rejects.toMatchObject({ code: 'not_found' })
    groups[1]!.memberIds.push('sam')
    expect((await getQuestion(deps, 'sam', q.id)).id).toBe(q.id)
  })

  it('refuses an empty or long question, unknown groups and people, an empty chosen audience, too many tags', async () => {
    const { deps } = setup()
    const ask = (input: Parameters<typeof askQuestion>[2]) => askQuestion(deps, person('ony'), input)
    await expect(ask({ text: '   ', tags: [], audience: { kind: 'company' } })).rejects.toMatchObject({ code: 'invalid' })
    await expect(ask({ text: 'x'.repeat(501), tags: [], audience: { kind: 'company' } })).rejects.toMatchObject({ code: 'invalid' })
    await expect(ask({ text: 'Q?', tags: [], audience: { kind: 'chosen', groupIds: [], userIds: [] } })).rejects.toMatchObject({ code: 'invalid' })
    await expect(ask({ text: 'Q?', tags: [], audience: { kind: 'chosen', groupIds: ['nope'], userIds: [] } })).rejects.toThrow(/No such group/)
    await expect(ask({ text: 'Q?', tags: [], audience: { kind: 'chosen', groupIds: [], userIds: ['contact-1'] } })).rejects.toThrow(/not a member/)
    await expect(ask({ text: 'Q?', tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], audience: { kind: 'company' } })).rejects.toThrow(/at most 8/)
    await expect(askQuestion(deps, person('stranger'), { text: 'Q?', tags: [], audience: { kind: 'company' } })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('someone who is no member of the company reads nothing, not even company-wide questions', async () => {
    const { deps } = setup()
    const q = await askQuestion(deps, person('ony'), { text: 'Q?', tags: ['hr'], audience: { kind: 'company' } })
    await expect(listQuestions(deps, 'stranger', {})).rejects.toMatchObject({ code: 'forbidden' })
    await expect(getQuestion(deps, 'stranger', q.id)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(listQuestionTags(deps, 'stranger')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(listAudience(deps, 'stranger')).rejects.toMatchObject({ code: 'forbidden' })
    expect(await listAudience(deps, 'ony')).toEqual({
      groups: [
        { id: 'g-sales', name: 'Sales' },
        { id: 'g-dev', name: 'Dev' },
      ],
      people: MEMBERS,
    })
  })

  it('normalises tags structurally: trim, collapse spaces, drop a leading #, lower case, dedupe', () => {
    expect(normaliseTags(['  Kunden  Service ', '#HR', 'hr', ''])).toEqual(['kunden service', 'hr'])
    expect(() => normaliseTags(['x'.repeat(41)])).toThrow(TeamQuestionError)
  })

  it('filters by tag and status; tags list counts the visible questions', async () => {
    const { deps } = setup()
    const a = await askQuestion(deps, person('ony'), { text: 'A?', tags: ['hr'], audience: { kind: 'company' } })
    const b = await askQuestion(deps, person('ony'), { text: 'B?', tags: ['hr', 'it'], audience: { kind: 'company' } })
    await closeQuestion(deps, person('ony'), a.id)
    expect((await listQuestions(deps, 'alex', { tag: 'HR' })).questions.map((q) => q.id)).toEqual([b.id, a.id])
    expect((await listQuestions(deps, 'alex', { tag: 'hr', status: 'open' })).questions.map((q) => q.id)).toEqual([b.id])
    expect((await listQuestions(deps, 'alex', { status: 'closed' })).questions.map((q) => q.id)).toEqual([a.id])
    expect((await listQuestions(deps, 'alex', { forMe: true })).questions.map((q) => q.id)).toEqual([b.id])
    expect((await listQuestionTags(deps, 'alex')).tags).toEqual([
      { tag: 'hr', count: 2 },
      { tag: 'it', count: 1 },
    ])
  })

  it('only the asker closes; a closed question takes no answers', async () => {
    const { deps } = setup()
    const q = await askQuestion(deps, person('ony'), { text: 'Q?', tags: [], audience: { kind: 'company' } })
    await expect(closeQuestion(deps, person('alex'), q.id)).rejects.toMatchObject({ code: 'forbidden' })
    const closed = await closeQuestion(deps, person('ony'), q.id)
    expect(closed).toMatchObject({ status: 'closed', forMe: false })
    expect(closed.closedAt).not.toBeNull()
    await expect(closeQuestion(deps, person('ony'), q.id)).rejects.toMatchObject({ code: 'conflict' })
    await expect(answerQuestion(deps, person('alex'), q.id, 'Late')).rejects.toMatchObject({ code: 'conflict' })
    await expect(answerQuestion(deps, person('alex'), 'missing', 'x')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('refuses an empty or overlong answer; records the assistant when it answers on the person’s word', async () => {
    const { deps } = setup()
    const q = await askQuestion(deps, { userId: 'ony', via: 'assistant' }, { text: 'Q?', tags: [], audience: { kind: 'company' } })
    expect(q.createdVia).toBe('assistant')
    await expect(answerQuestion(deps, person('alex'), q.id, '  ')).rejects.toMatchObject({ code: 'invalid' })
    await expect(answerQuestion(deps, person('alex'), q.id, 'x'.repeat(4001))).rejects.toMatchObject({ code: 'invalid' })
    const a = await answerQuestion(deps, { userId: 'alex', via: 'assistant' }, q.id, 'Yes.')
    expect(a.answers[0]).toMatchObject({ createdVia: 'assistant' })
  })

  it('names a former member when the asker or an answerer left', async () => {
    const { deps } = setup()
    const q = await askQuestion(deps, person('ony'), { text: 'Q?', tags: [], audience: { kind: 'company' } })
    deps.directory.get = async (id) => MEMBERS.find((m) => m.id === id && id !== 'ony') ?? null
    expect((await getQuestion(deps, 'alex', q.id)).author).toEqual({ id: 'ony', name: 'A former member' })
  })
})
