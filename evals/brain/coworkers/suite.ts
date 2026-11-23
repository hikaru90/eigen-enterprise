import type { EvalCompany } from '../harness'
import type { Crawls } from '../leaks'
import type { CompanyFixture, CoworkerKey, MemberKey } from '../types'
import type { ScriptedGateway } from './gateway'
import type { CoworkerLeakResult, CoworkerReachResult, ReadOnlyViewResult } from './keeps'
import type { ScriptCast } from './scripts'
import { randomUUID } from 'node:crypto'
import { DIFFERENT_MAX_PAIRWISE_COSINE } from '../baseline'
import { DIFFERENT_QUESTION, DOES_LAUNCH, DOES_PING_PONG, PROMISED_THREAD_BUDGET, READ_ONLY_PROBE } from '../suites/coworkers'
import { coworkerLeakResults, coworkerReachResults, readOnlyViews } from './keeps'
import { coworkerOf, LAUNCH_THOUGHT_MARKER, launchScript, pingPongScript } from './scripts'

/**
 * Runs the co-workers suite (C8) on the seeded eval company. Keeps comes
 * from the tool-level crawl plus a write probe; Does needs the scripted model
 * (the co-workers' turns run for real: the Messages trigger, the turn queue,
 * the durable engine, the gateway, the cost log); Different needs real models.
 * Each part that cannot run in this mode says so in `skipped` — never silent.
 */

export type WriteProbe = { as: string; via: 'person' | 'brain' | 'coworker'; refused: boolean; error: string | null }
export type CheckResult = { id: string; concept: string; pass: boolean; detail: unknown }
export type DifferentResult = {
  question: string
  answers: Array<{ coworker: CoworkerKey; model: string; text: string }>
  pairwiseCosine: Array<{ a: CoworkerKey; b: CoworkerKey; cosine: number }>
  maxPairwiseCosine: number
  threshold: number
  pass: boolean
  /** TODO(CB2): "do these take distinct positions?" is a closed-set question for Jev; not wired until CB2 exists. */
  jevJudge: { status: 'todo'; question: string }
}
export type Skipped = { skipped: string }

export type CoworkersResult = {
  keeps: { leaks: CoworkerLeakResult[]; reach: CoworkerReachResult[]; readOnly: ReadOnlyViewResult; writeProbe: { pass: boolean; probes: WriteProbe[]; unchanged: boolean } }
  does: { checks: CheckResult[] } | Skipped
  different: DifferentResult | Skipped
}

export type CoworkersMode =
  | { kind: 'static' }
  | { kind: 'mock'; gateway: ScriptedGateway }
  | { kind: 'platform'; embedAs: string }

export const SKIP_DOES_STATIC = 'skipped: needs the scripted model (npm run eval:brain -- --mode chat --provider mock)'
export const SKIP_DOES_PLATFORM = 'skipped: scripted turns run against the mock gateway only (--provider mock)'
export const SKIP_DIFFERENT = 'skipped: needs real models (npm run eval:brain -- --mode chat --provider platform)'

export async function runCoworkersSuite(company: EvalCompany, f: CompanyFixture, crawls: Crawls, mode: CoworkersMode): Promise<CoworkersResult> {
  const keeps = {
    leaks: coworkerLeakResults(f, crawls),
    reach: coworkerReachResults(crawls),
    readOnly: readOnlyViews(f, crawls, company.seeded.ids),
    writeProbe: await probeReadOnly(company, f),
  }
  if (mode.kind === 'static') return { keeps, does: { skipped: SKIP_DOES_STATIC }, different: { skipped: SKIP_DIFFERENT } }

  const turns = await company.startCoworkerTurns()
  try {
    if (mode.kind === 'mock') return { keeps, does: { checks: await runDoes(company, f, mode.gateway) }, different: { skipped: SKIP_DIFFERENT } }
    return { keeps, does: { skipped: SKIP_DOES_PLATFORM }, different: await runDifferent(company, f, mode.embedAs) }
  } finally {
    turns.stop()
    await turns.turns.idle()
  }
}

// ── Keeps: a co-worker's thought is read-only to everyone else ──────────────

async function probeReadOnly(company: EvalCompany, f: CompanyFixture): Promise<CoworkersResult['keeps']['writeProbe']> {
  const { appSql } = await import('$lib/server/db')
  const { personFor } = await import('$lib/server/auth/user-role')
  const thoughtId = company.seeded.ids.get(READ_ONLY_PROBE)
  if (!thoughtId) throw new Error(`${READ_ONLY_PROBE} was not seeded`)
  const state = async () => (await appSql<{ s: string }[]>`select lifecycle_status || ':' || coalesce(normalized_text_encrypted, '') as s from thought where id = ${thoughtId}`)[0]?.s
  const before = await state()
  const input = { thought_id: thoughtId, status: 'archived' }
  const probes: WriteProbe[] = []
  const attempt = async (as: string, via: WriteProbe['via'], run: () => Promise<unknown>) => {
    try {
      await run()
      probes.push({ as, via, refused: false, error: null })
    } catch (err) {
      probes.push({ as, via, refused: true, error: err instanceof Error ? err.message.slice(0, 160) : String(err) })
    }
  }
  for (const m of f.members) {
    const person = await personFor(company.seeded.member[m.key])
    if (!person) throw new Error(`${m.key} is no member`)
    await attempt(m.key, 'person', () =>
      company.boot.kernel.registry.execute('memory.set_thought_status', input, { principal: { id: person.id, kind: 'human', roles: person.roles }, requestId: randomUUID() }),
    )
    await attempt(m.key, 'brain', () => company.exec(m.key, 'memory.set_thought_status', input))
  }
  const owner = f.thoughts.find((t) => t.id === READ_ONLY_PROBE)!.owner
  for (const c of f.coworkers.filter((x) => x.key !== owner)) {
    await attempt(c.key, 'coworker', () => company.execAsCoworker(c.key, 'memory.set_thought_status', input))
  }
  const unchanged = (await state()) === before
  return { pass: unchanged && probes.every((p) => p.refused), probes, unchanged }
}

// ── Does: the three-co-worker task and the thread budget ───────────────────

type RunRow = { id: string; coworker_user_id: string; status: string; stop_reason: string | null; cost_usd: string; thread_root_id: string | null; conversation_id: string | null }

async function runsWhere(column: 'thread_root_id' | 'conversation_id', id: string): Promise<RunRow[]> {
  const { appSql } = await import('$lib/server/db')
  return column === 'thread_root_id'
    ? appSql<RunRow[]>`select id, coworker_user_id, status, stop_reason, cost_usd::text, thread_root_id, conversation_id from coworker_run where thread_root_id = ${id} order by triggered_at, id`
    : appSql<RunRow[]>`select id, coworker_user_id, status, stop_reason, cost_usd::text, thread_root_id, conversation_id from coworker_run where conversation_id = ${id} order by triggered_at, id`
}

/** Until `expected` runs exist and none is queued or running (bounded: the eval never waits more than 45 s). */
async function settle(column: 'thread_root_id' | 'conversation_id', id: string, expected: number): Promise<RunRow[]> {
  const deadline = Date.now() + 45_000
  const finished = (rows: RunRow[]) => rows.length >= expected && rows.every((r) => r.status !== 'queued' && r.status !== 'running')
  for (;;) {
    const rows = await runsWhere(column, id)
    if (finished(rows)) {
      await new Promise((r) => setTimeout(r, 500))
      const again = await runsWhere(column, id)
      if (again.length === rows.length && finished(again)) return again
    }
    if (Date.now() > deadline) throw new Error(`co-worker turns did not settle within 45 s: ${JSON.stringify(rows.map((r) => [r.coworker_user_id, r.status]))}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

async function castOf(company: EvalCompany, f: CompanyFixture, asker: MemberKey) {
  const { messagesDeps } = await import('../../../modules/messages/live')
  const { primaryHandle } = await import('../../../modules/messages/notify')
  const deps = await messagesDeps()
  const people = await deps.directory.listPeople()
  const seat = (id: string) => {
    const p = people.find((x) => x.id === id)
    if (!p) throw new Error(`${id} is not in the people directory`)
    return { name: p.name, handle: primaryHandle(p) }
  }
  const cast = { asker: seat(company.seeded.member[asker]) } as ScriptCast
  for (const c of f.coworkers) cast[c.key] = seat(c.id)
  return { deps, cast, handleOf: (id: string) => seat(id).handle }
}

async function runDoes(company: EvalCompany, f: CompanyFixture, gateway: ScriptedGateway): Promise<CheckResult[]> {
  const { appSql } = await import('$lib/server/db')
  const { postMessage, listThread } = await import('../../../modules/messages/service')
  const { COWORKER_TEMPLATES } = await import('$lib/server/coworkers')
  const { stopNote } = await import('$lib/server/coworkers/turns')
  const { dbNow } = await import('../state')
  const { deps, cast, handleOf } = await castOf(company, f, DOES_LAUNCH.asker)
  const askerId = company.seeded.member[DOES_LAUNCH.asker]
  const conv = company.seeded.ids.get(DOES_LAUNCH.channelId)
  if (!conv) throw new Error(`${DOES_LAUNCH.channelId} was not seeded`)
  const keyOf = new Map(f.coworkers.map((c) => [c.id, c.key]))
  const cw = Object.fromEntries(f.coworkers.map((c) => [c.key, c])) as Record<CoworkerKey, CompanyFixture['coworkers'][number]>
  const checks: CheckResult[] = []
  const check = (id: string, concept: string, pass: boolean, detail: unknown) => checks.push({ id, concept, pass, detail })

  // 1. The launch: a person asks Marketing; Marketing pulls in GTM and the Designer.
  gateway.setScript(launchScript(cast, DOES_LAUNCH.product))
  const firstRequest = gateway.requests.length
  const since = await dbNow()
  const { message: root } = await postMessage(deps, askerId, conv, `@${cast.marketing.handle} plan the launch of ${DOES_LAUNCH.product}`)
  const runs = await settle('thread_root_id', root.id, 5)
  const { parent, replies } = await listThread(deps, askerId, root.id)
  const thread = [parent, ...replies]
  const authors = thread.map((m) => keyOf.get(m.authorId) ?? (m.authorId === askerId ? DOES_LAUNCH.asker : m.authorId))
  const expectedAuthors = [DOES_LAUNCH.asker, 'marketing', 'gtm', 'marketing', 'designer', 'marketing']
  check('CD01', 'thread-collaboration', JSON.stringify(authors) === JSON.stringify(expectedAuthors) && runs.length === 5 && runs.every((r) => r.status === 'done'), {
    authors,
    expected: expectedAuthors,
    runs: runs.map((r) => [keyOf.get(r.coworker_user_id), r.status, r.stop_reason]),
  })
  const last = thread.at(-1)!
  check('CD02', 'answer-to-the-asker', keyOf.get(last.authorId) === 'marketing' && last.body.includes(`@${cast.asker.handle}`), { author: keyOf.get(last.authorId) ?? last.authorId, body: last.body.slice(0, 200) })

  const asked = gateway.requests.slice(firstRequest).map((r) => ({ ...r, who: coworkerOf(r, cast) })).filter((r) => r.who !== null)
  const perCoworker = Object.fromEntries(f.coworkers.map((c) => [c.key, asked.filter((r) => r.who === c.key)])) as Record<CoworkerKey, typeof asked>
  const wrongModel = asked.filter((r) => r.model !== cw[r.who!].modelId).map((r) => ({ coworker: r.who, model: r.model }))
  check('CD03', 'own-model', wrongModel.length === 0 && f.coworkers.every((c) => perCoworker[c.key].length > 0) && asked.every((r) => r.answered === 'script'), {
    requests: Object.fromEntries(f.coworkers.map((c) => [c.key, perCoworker[c.key].map((r) => r.model)])),
    wrongModel,
    unanswered: asked.filter((r) => r.answered !== 'script').length,
  })
  const lensOf = (k: CoworkerKey) => COWORKER_TEMPLATES.find((t) => t.id === cw[k].templateId)!.lens
  const roleLine = (k: CoworkerKey) => `You are ${cast[k].name} (@${cast[k].handle})`
  const wrongCard = asked
    .filter((r) => !r.system.includes(lensOf(r.who!)) || f.coworkers.some((c) => c.key !== r.who && r.system.includes(roleLine(c.key))))
    .map((r) => r.who)
  check('CD04', 'own-role-card', wrongCard.length === 0 && asked.length > 0, { requests: asked.length, wrongCard })

  const costRows = await appSql<{ group_id: string | null; user_id: string; usd: string }[]>`
    select group_id::text, user_id, total_cost_usd::text as usd from activity_call_log where group_id in ${appSql(runs.map((r) => r.id))}`
  const costOf = runs.map((r) => {
    const rows = costRows.filter((c) => c.group_id === r.id)
    const sum = rows.reduce((n, c) => n + Number(c.usd), 0)
    return { coworker: keyOf.get(r.coworker_user_id), calls: rows.length, billedTo: [...new Set(rows.map((c) => keyOf.get(c.user_id) ?? c.user_id))], runUsd: Number(r.cost_usd), logUsd: sum }
  })
  check(
    'CD05',
    'own-costs',
    costOf.every((c) => c.calls > 0 && c.billedTo.length === 1 && c.billedTo[0] === c.coworker && c.runUsd > 0 && Math.abs(c.runUsd - c.logUsd) < 1e-6),
    costOf,
  )

  const thoughts = await appSql<{ user_id: string; author: string }[]>`
    select user_id, author from thought where user_id in ${appSql(f.coworkers.map((c) => c.id))} and created_at >= ${since.toISOString()}::timestamptz`
  check('CD06', 'thought-captured', thoughts.some((t) => t.author === 'agent' && keyOf.has(t.user_id)), {
    captured: thoughts.map((t) => keyOf.get(t.user_id) ?? t.user_id),
    marker: LAUNCH_THOUGHT_MARKER,
  })

  // 2. The forced ping-pong: only the thread budget ends it, with a visible note.
  gateway.setScript(pingPongScript(cast, DOES_PING_PONG.between))
  const pingStart = gateway.requests.length
  const { message: loopRoot } = await postMessage(deps, askerId, conv, `@${cast[DOES_PING_PONG.between[0]].handle} let's see how long you two keep going`)
  const loop = await settle('thread_root_id', loopRoot.id, PROMISED_THREAD_BUDGET + 1)
  const loopThread = await listThread(deps, askerId, loopRoot.id)
  const note = loopThread.replies.at(-1)
  const stopper = note ? cw[keyOf.get(note.authorId) as CoworkerKey] : undefined
  const human = stopper ? await import('$lib/server/coworkers').then((s) => s.accountableHumanFor(stopper.id)) : null
  const expectedNote = human ? stopNote({ reason: 'thread_budget', humanHandle: handleOf(human.id), budget: PROMISED_THREAD_BUDGET, dailyCapUsd: 0 }) : null
  const loopRequests = gateway.requests.slice(pingStart).filter((r) => coworkerOf(r, cast) !== null).length
  const statuses = loop.map((r) => r.status)
  check(
    'CD07',
    'thread-budget',
    loop.length === PROMISED_THREAD_BUDGET + 1 &&
      statuses.slice(0, PROMISED_THREAD_BUDGET).every((s) => s === 'done') &&
      loop[PROMISED_THREAD_BUDGET]?.status === 'stopped' &&
      loop[PROMISED_THREAD_BUDGET]?.stop_reason === 'thread_budget' &&
      loopRequests === PROMISED_THREAD_BUDGET &&
      note?.body === expectedNote,
    { statuses, stopReason: loop.at(-1)?.stop_reason, modelRequests: loopRequests, note: note?.body.slice(0, 200), expectedNote },
  )
  gateway.setScript(null)
  return checks
}

// ── Different: the same open question to the three, measured by the embedding model ──

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) throw new Error(`cosine of vectors of length ${a.length} and ${b.length}`)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) throw new Error('cosine of a zero vector')
  return dot / Math.sqrt(na * nb)
}

async function runDifferent(company: EvalCompany, f: CompanyFixture, embedAs: string): Promise<DifferentResult> {
  const { openDm, postMessage, listMessages } = await import('../../../modules/messages/service')
  const { llmCreateEmbeddings } = await import('$lib/server/llm/llm-client')
  const { extractEmbeddings } = await import('$lib/server/llm/embedding')
  const { deps } = await castOf(company, f, DIFFERENT_QUESTION.asker)
  const askerId = company.seeded.member[DIFFERENT_QUESTION.asker]
  const answers: DifferentResult['answers'] = []
  const dms = []
  for (const c of f.coworkers) {
    const dm = await openDm(deps, askerId, [c.id])
    await postMessage(deps, askerId, dm.id, DIFFERENT_QUESTION.text)
    dms.push({ c, dm })
  }
  for (const { c, dm } of dms) {
    const runs = await settle('conversation_id', dm.id, 1)
    if (runs[0]?.status !== 'done') throw new Error(`Different: ${c.key}'s turn ended ${runs[0]?.status} (${runs[0]?.stop_reason ?? 'no reason'})`)
    const { messages } = await listMessages(deps, askerId, dm.id, { limit: 20 })
    const reply = messages.find((m) => m.authorId === c.id)
    if (!reply) throw new Error(`Different: ${c.key} posted no answer in its DM`)
    answers.push({ coworker: c.key, model: c.modelId, text: reply.body })
  }
  const vectors = extractEmbeddings(await llmCreateEmbeddings({ userId: embedAs, input: answers.map((a) => a.text) }))
  if (vectors.length !== answers.length) throw new Error(`Different: ${vectors.length} embeddings for ${answers.length} answers`)
  const pairwiseCosine: DifferentResult['pairwiseCosine'] = []
  for (let i = 0; i < answers.length; i++) {
    for (let j = i + 1; j < answers.length; j++) pairwiseCosine.push({ a: answers[i]!.coworker, b: answers[j]!.coworker, cosine: cosine(vectors[i]!, vectors[j]!) })
  }
  const maxPairwiseCosine = Math.max(...pairwiseCosine.map((p) => p.cosine))
  return {
    question: DIFFERENT_QUESTION.text,
    answers,
    pairwiseCosine,
    maxPairwiseCosine,
    threshold: DIFFERENT_MAX_PAIRWISE_COSINE,
    pass: maxPairwiseCosine <= DIFFERENT_MAX_PAIRWISE_COSINE,
    jevJudge: { status: 'todo', question: 'Do these three answers take distinct positions? (closed set: yes | no) — Jev, once CB2 lands' },
  }
}
