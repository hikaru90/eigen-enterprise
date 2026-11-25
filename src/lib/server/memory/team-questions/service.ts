import { inAudience, type QuestionStatus, type QuestionVia, type QuestionViewer, type TeamQuestion, type TeamQuestionStore } from './store'

/**
 * Team questions (Contribute 057cd4d5, Ony): "where do I put questions for
 * the staff that they read short and crisp and answer — not the chat". A
 * member puts a one-line question to the whole company or to chosen groups
 * and people, with free tags (categories, topics); the audience finds it in
 * Memory › Questions (open for them until they answered) and answers inline.
 *
 * Not Memory: Memory is private per person; a question is a company-level
 * record (migration 0183) its asker and its audience read. Group membership is
 * read when the question is read, so someone who joins Sales later sees what
 * was asked of Sales. Only the asker closes a question; a closed one keeps its
 * answers and takes no new ones. People come from the company's members (the
 * directory), never from contacts.
 *
 * Tags are the asker's own words, normalised structurally (trim, spaces, a
 * leading #, lower case) — no model reads them and none is suggested: the
 * page autocompletes from the tags already in use (listQuestionTags).
 */

export type QuestionPerson = { id: string; name: string }

export type QuestionDirectory = {
  get(id: string): Promise<QuestionPerson | null>
  list(): Promise<QuestionPerson[]>
}

export type QuestionGroup = { id: string; name: string; memberIds: string[] }

export type TeamQuestionDeps = {
  store: TeamQuestionStore
  directory: QuestionDirectory
  groups: { list(): Promise<QuestionGroup[]> }
  now?: () => Date
  newId?: () => string
}

/** Who acts: the person themself, or their assistant on their word in chat. */
export type QuestionActor = { userId: string; via: QuestionVia }

export type QuestionAudienceInput = { kind: 'company' } | { kind: 'chosen'; groupIds: string[]; userIds: string[] }

export type TeamQuestionView = {
  id: string
  text: string
  tags: string[]
  audience: { kind: 'company' | 'chosen'; groups: Array<{ id: string; name: string }>; people: QuestionPerson[] }
  status: QuestionStatus
  createdVia: QuestionVia
  createdAt: string
  closedAt: string | null
  author: QuestionPerson
  answers: Array<{ id: string; author: QuestionPerson; text: string; createdVia: QuestionVia; at: string }>
  /** The viewer asked it. */
  mine: boolean
  /** The viewer answered it at least once. */
  answeredByMe: boolean
  /** Open, asked of the viewer by someone else, not answered by them yet. */
  forMe: boolean
}

export type QuestionFilter = { tag?: string; status?: QuestionStatus | 'all'; forMe?: boolean }

export class TeamQuestionError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'forbidden' | 'conflict',
    message: string,
  ) {
    super(message)
    this.name = 'TeamQuestionError'
  }
}

export const QUESTIONS_URL = '/m/memory/questions'
export const FORMER_MEMBER = 'A former member'
export const QUESTION_MAX = 500
export const ANSWER_MAX = 4000
export const TAG_MAX = 40
export const TAGS_MAX = 8

const nowOf = (d: TeamQuestionDeps) => (d.now ? d.now() : new Date())
const newIdOf = (d: TeamQuestionDeps) => (d.newId ? d.newId() : crypto.randomUUID())

/** One tag as stored: trimmed, inner whitespace collapsed, a leading # dropped, lower case. */
function normaliseTag(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().replace(/^#+/, '').trim().toLowerCase()
}

/** The asker's tags as stored: normalised, empty ones dropped, duplicates once, at most TAGS_MAX. */
export function normaliseTags(raw: readonly string[]): string[] {
  const tags: string[] = []
  for (const r of raw) {
    const tag = normaliseTag(r)
    if (!tag) continue
    if (tag.length > TAG_MAX) throw new TeamQuestionError('invalid', `Keep a tag under ${TAG_MAX} characters.`)
    if (!tags.includes(tag)) tags.push(tag)
  }
  if (tags.length > TAGS_MAX) throw new TeamQuestionError('invalid', `A question takes at most ${TAGS_MAX} tags.`)
  return tags
}

async function viewerOf(d: TeamQuestionDeps, userId: string, groups?: QuestionGroup[]): Promise<QuestionViewer> {
  const all = groups ?? (await d.groups.list())
  return { userId, groupIds: all.filter((g) => g.memberIds.includes(userId)).map((g) => g.id) }
}

async function requireMember(d: TeamQuestionDeps, userId: string): Promise<QuestionPerson> {
  const me = await d.directory.get(userId)
  if (!me) throw new TeamQuestionError('forbidden', 'Only members of this company ask and answer team questions.')
  return me
}

/** Turns rows into views for one viewer; names are looked up once per call. */
async function views(d: TeamQuestionDeps, viewer: QuestionViewer, questions: TeamQuestion[], groups: QuestionGroup[]): Promise<TeamQuestionView[]> {
  if (questions.length === 0) return []
  const answers = await d.store.answers(questions.map((q) => q.id))
  const names = new Map<string, Promise<QuestionPerson>>()
  const personOf = (id: string) => {
    let p = names.get(id)
    if (!p) {
      p = d.directory.get(id).then((m) => (m ? { id: m.id, name: m.name } : { id, name: FORMER_MEMBER }))
      names.set(id, p)
    }
    return p
  }
  const groupName = new Map(groups.map((g) => [g.id, g.name]))
  return Promise.all(
    questions.map(async (q) => {
      const own = answers.filter((a) => a.questionId === q.id)
      const answeredByMe = own.some((a) => a.authorId === viewer.userId)
      const mine = q.authorId === viewer.userId
      return {
        id: q.id,
        text: q.text,
        tags: [...q.tags],
        audience: {
          kind: q.audienceKind,
          // A group deleted since the question was asked is left out (its members no longer match it either).
          groups: q.audienceGroupIds.flatMap((id) => (groupName.has(id) ? [{ id, name: groupName.get(id)! }] : [])),
          people: await Promise.all(q.audienceUserIds.map(personOf)),
        },
        status: q.status,
        createdVia: q.createdVia,
        createdAt: q.createdAt.toISOString(),
        closedAt: q.closedAt ? q.closedAt.toISOString() : null,
        author: await personOf(q.authorId),
        answers: await Promise.all(
          own.map(async (a) => ({ id: a.id, author: await personOf(a.authorId), text: a.body, createdVia: a.createdVia, at: a.createdAt.toISOString() })),
        ),
        mine,
        answeredByMe,
        forMe: q.status === 'open' && !mine && !answeredByMe,
      }
    }),
  )
}

/** A question the person may read (asker or audience); anyone else gets "not found". */
async function visible(d: TeamQuestionDeps, userId: string, id: string): Promise<{ q: TeamQuestion; viewer: QuestionViewer; groups: QuestionGroup[] }> {
  const groups = await d.groups.list()
  const viewer = await viewerOf(d, userId, groups)
  const q = await d.store.get(id)
  if (!q || !inAudience(q, viewer)) throw new TeamQuestionError('not_found', 'Question not found.')
  return { q, viewer, groups }
}

async function one(d: TeamQuestionDeps, viewer: QuestionViewer, q: TeamQuestion, groups: QuestionGroup[]): Promise<TeamQuestionView> {
  const [v] = await views(d, viewer, [q], groups)
  return v!
}

export async function askQuestion(
  d: TeamQuestionDeps,
  actor: QuestionActor,
  input: { text: string; tags: readonly string[]; audience: QuestionAudienceInput },
): Promise<TeamQuestionView> {
  await requireMember(d, actor.userId)
  const text = input.text.replace(/\s+/g, ' ').trim()
  if (!text) throw new TeamQuestionError('invalid', 'Write the question.')
  if (text.length > QUESTION_MAX) throw new TeamQuestionError('invalid', `Keep the question short: at most ${QUESTION_MAX} characters.`)
  const tags = normaliseTags(input.tags)
  const groups = await d.groups.list()
  let groupIds: string[] = []
  let userIds: string[] = []
  if (input.audience.kind === 'chosen') {
    groupIds = [...new Set(input.audience.groupIds)]
    userIds = [...new Set(input.audience.userIds)]
    if (groupIds.length + userIds.length === 0)
      throw new TeamQuestionError('invalid', 'Pick at least one group or person, or ask the whole company.')
    const unknownGroup = groupIds.find((id) => !groups.some((g) => g.id === id))
    if (unknownGroup) throw new TeamQuestionError('invalid', `No such group: ${unknownGroup} (members.group_list).`)
    for (const id of userIds) {
      if (!(await d.directory.get(id)))
        throw new TeamQuestionError('invalid', `${id} is not a member of this company. Pick a member (members.list), not a contact.`)
    }
  }
  const at = nowOf(d)
  const question: TeamQuestion = {
    id: newIdOf(d),
    authorId: actor.userId,
    text,
    tags,
    audienceKind: input.audience.kind,
    audienceGroupIds: groupIds,
    audienceUserIds: userIds,
    status: 'open',
    createdVia: actor.via,
    createdAt: at,
    updatedAt: at,
    closedAt: null,
  }
  await d.store.insert(question)
  return one(d, await viewerOf(d, actor.userId, groups), question, groups)
}

export async function listQuestions(d: TeamQuestionDeps, userId: string, filter: QuestionFilter): Promise<{ questions: TeamQuestionView[] }> {
  await requireMember(d, userId)
  const groups = await d.groups.list()
  const viewer = await viewerOf(d, userId, groups)
  const tag = filter.tag ? normaliseTag(filter.tag) : null
  const status = filter.status ?? 'all'
  const rows = (await d.store.listVisible(viewer)).filter(
    (q) => (!tag || q.tags.includes(tag)) && (status === 'all' || q.status === status),
  )
  const all = await views(d, viewer, rows, groups)
  return { questions: filter.forMe ? all.filter((q) => q.forMe) : all }
}

export async function getQuestion(d: TeamQuestionDeps, userId: string, id: string): Promise<TeamQuestionView> {
  await requireMember(d, userId)
  const { q, viewer, groups } = await visible(d, userId, id)
  return one(d, viewer, q, groups)
}

export async function answerQuestion(d: TeamQuestionDeps, actor: QuestionActor, id: string, text: string): Promise<TeamQuestionView> {
  await requireMember(d, actor.userId)
  const body = text.trim()
  if (!body) throw new TeamQuestionError('invalid', 'Write the answer.')
  if (body.length > ANSWER_MAX) throw new TeamQuestionError('invalid', `Keep the answer under ${ANSWER_MAX} characters.`)
  const { q, viewer, groups } = await visible(d, actor.userId, id)
  if (q.status !== 'open') throw new TeamQuestionError('conflict', 'This question is closed: it takes no new answers.')
  const updated = await d.store.addAnswer({ id: newIdOf(d), questionId: q.id, authorId: actor.userId, body, createdVia: actor.via, createdAt: nowOf(d) })
  if (!updated) throw new TeamQuestionError('conflict', 'This question was closed meanwhile: it takes no new answers.')
  return one(d, viewer, updated, groups)
}

export async function closeQuestion(d: TeamQuestionDeps, actor: QuestionActor, id: string): Promise<TeamQuestionView> {
  await requireMember(d, actor.userId)
  const { q, viewer, groups } = await visible(d, actor.userId, id)
  if (q.authorId !== actor.userId) throw new TeamQuestionError('forbidden', 'Only the person who asked closes a question.')
  if (q.status !== 'open') throw new TeamQuestionError('conflict', 'This question is already closed.')
  const closed = await d.store.close(q.id, nowOf(d))
  if (!closed) throw new TeamQuestionError('conflict', 'This question is already closed.')
  return one(d, viewer, closed, groups)
}

/** The tags in use on the questions the person can read, most used first (the page's autocomplete). */
export async function listQuestionTags(d: TeamQuestionDeps, userId: string): Promise<{ tags: Array<{ tag: string; count: number }> }> {
  await requireMember(d, userId)
  const viewer = await viewerOf(d, userId)
  const counts = new Map<string, number>()
  for (const q of await d.store.listVisible(viewer)) for (const t of q.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
  return {
    tags: [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
  }
}

/** Who a question can be put to: the company's groups and members (the page's audience picker). */
export async function listAudience(d: TeamQuestionDeps, userId: string): Promise<{ groups: Array<{ id: string; name: string }>; people: QuestionPerson[] }> {
  await requireMember(d, userId)
  const [groups, people] = await Promise.all([d.groups.list(), d.directory.list()])
  return { groups: groups.map((g) => ({ id: g.id, name: g.name })), people: people.map((p) => ({ id: p.id, name: p.name })) }
}
