import { KernelError } from '$lib/kernel/errors'
import type { ToolContext, ToolPrincipal } from '$lib/kernel/types'
import { OWNER, type Contact, type DemoDataset, type PersonHandle, type Teammate } from './types'
import { validateDataset } from './validate'

/**
 * The demo-company seed (plan/phase-demo-company.md D3): fills an empty,
 * claimed company by driving kernel registry tools in-process, each call as
 * the person it belongs to — the same execute path (permission, approval,
 * validation, audit) the ee CLI and the agent take. Teammates become real
 * members through `addTeammate` (the members invite + accept code path).
 */

export type PersonPrincipal = { id: string; roles: string[] }

export type SeedDeps = {
  registry: { execute(name: string, input: unknown, ctx: ToolContext): Promise<unknown> }
  /** The person who claimed the company. */
  owner: PersonPrincipal
  /** Make a teammate a real member (invite + accept); returns their user id and kernel roles. */
  addTeammate: (t: Teammate) => Promise<PersonPrincipal>
  now: Date
  log: (line: string) => void
}

export type SeedCounts = {
  teammates: number
  groups: number
  contacts: number
  contactLogs: number
  projects: number
  tasks: number
  tasksDone: number
  channels: number
  messages: number
  events: number
  docs: number
  brandSets: number
  pages: number
  memories: number
  approvals: number
}

export class AlreadySeededError extends Error {}
export class SeedRefusedError extends Error {}

/** The modules whose tools the seed uses; switched on first when off. */
export const SEED_MODULES = [
  'members',
  'contacts',
  'memory',
  'messages',
  'calendar',
  'drive',
  'brand',
  'website',
] as const

// ---- dates (all relative to the run day in the company's time zone) ----

function dayIn(timeZone: string, at: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** Monday of the week the day falls in. */
function mondayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0 = Sunday
  return addDays(day, -((weekday + 6) % 7))
}

// ---- tool outputs: read the id a tool returns, or fail loud ----

function field(result: unknown, path: string[], tool: string): string {
  let cur: unknown = result
  for (const key of path)
    cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[key] : undefined
  if (typeof cur !== 'string' || cur.length === 0) {
    throw new Error(`${tool} returned no ${path.join('.')}: ${JSON.stringify(result)}`)
  }
  return cur
}

export type MembersList = {
  members: { id: string; email: string; role: string }[]
  invites: { email: string }[]
}

/** Where a company stands for the seed (members.list as read by the owner). */
export type SeedState = {
  /** Someone at @<emailDomain> is a member or invited: the dataset is (being) seeded. */
  seeded: boolean
  /** Those addresses. */
  seededMembers: string[]
  members: number
  openInvites: number
  /** Freshly claimed: the owner is the only member and nobody is invited — the only company the seed fills. */
  fresh: boolean
}

export function seedState(d: Pick<DemoDataset, 'emailDomain'>, roster: MembersList): SeedState {
  const emails = [...roster.members.map((m) => m.email), ...roster.invites.map((i) => i.email)]
  const seededMembers = emails.filter((e) => e.toLowerCase().endsWith(`@${d.emailDomain}`))
  return {
    seeded: seededMembers.length > 0,
    seededMembers,
    members: roster.members.length,
    openInvites: roster.invites.length,
    fresh: roster.members.length === 1 && roster.invites.length === 0,
  }
}

export function asMembersList(result: unknown): MembersList {
  const r = result as Partial<MembersList> | null
  if (!r || !Array.isArray(r.members) || !Array.isArray(r.invites)) {
    throw new Error(`members.list returned an unexpected shape: ${JSON.stringify(result)}`)
  }
  return r as MembersList
}

function contactFields(c: Contact, companyName: string) {
  return {
    name: c.name,
    organisation: companyName,
    title: c.title,
    channels: [
      { type: 'email', value: c.email },
      ...(c.phone ? [{ type: 'phone', value: c.phone }] : []),
    ],
    met_how: c.metHow,
    why_relevant: c.whyRelevant,
    tags: c.tags,
  }
}

function contactState(c: Contact, today: string) {
  return {
    stage: c.stage,
    next_follow_up_on: c.nextFollowUpDay === undefined ? null : addDays(today, c.nextFollowUpDay),
    next_step: c.nextStep ?? null,
    latest_status: c.latestStatus ?? null,
  }
}

export async function seedDemoCompany(d: DemoDataset, deps: SeedDeps): Promise<SeedCounts> {
  const problems = validateDataset(d)
  if (problems.length > 0)
    throw new SeedRefusedError(`the dataset is not sound:\n- ${problems.join('\n- ')}`)

  const counts: SeedCounts = {
    teammates: 0,
    groups: 0,
    contacts: 0,
    contactLogs: 0,
    projects: 0,
    tasks: 0,
    tasksDone: 0,
    channels: 0,
    messages: 0,
    events: 0,
    docs: 0,
    brandSets: 0,
    pages: 0,
    memories: 0,
    approvals: 0,
  }
  const people = new Map<PersonHandle, PersonPrincipal>([[OWNER, deps.owner]])
  const person = (h: PersonHandle): PersonPrincipal => {
    const p = people.get(h)
    if (!p) throw new Error(`no member for "${h}" yet`)
    return p
  }
  const ctxOf = (p: PersonPrincipal): ToolContext => {
    const principal: ToolPrincipal = { id: p.id, kind: 'human', roles: p.roles }
    return { principal, requestId: crypto.randomUUID() }
  }

  /**
   * One registry call as a person. The company's approval mode applies: a
   * gated call waits for a decision, which the owner (who runs the seed) gives
   * through kernel.approvals_decide, exactly like approving it in chat — then
   * the call runs once more.
   */
  const run = async (
    as: PersonHandle,
    tool: string,
    input: Record<string, unknown>,
  ): Promise<unknown> => {
    try {
      return await deps.registry.execute(tool, input, ctxOf(person(as)))
    } catch (err) {
      const approvalId =
        err instanceof KernelError && err.code === 'approval_required'
          ? err.details?.approvalId
          : undefined
      if (typeof approvalId !== 'string') throw err
      await deps.registry.execute(
        'kernel.approvals_decide',
        { approval_id: approvalId, decision: 'approved' },
        ctxOf(deps.owner),
      )
      counts.approvals++
      deps.log(`approved ${tool} for ${as} (approval ${approvalId})`)
      return deps.registry.execute(tool, input, ctxOf(person(as)))
    }
  }

  // 1. Empty and not seeded yet — checked before anything is written (Members is core, always on).
  const state = seedState(d, asMembersList(await run(OWNER, 'members.list', {})))
  if (state.seeded) {
    throw new AlreadySeededError(
      `${d.companyName} is already seeded on this company (${state.seededMembers.join(', ')}); refusing to seed twice.`,
    )
  }
  if (!state.fresh) {
    throw new SeedRefusedError(
      `the company is not empty (${state.members} members, ${state.openInvites} open invites): the demo seed fills a freshly claimed company only.`,
    )
  }

  // 2. The modules the seed uses are on.
  const modules = (await run(OWNER, 'kernel.module_list', {})) as { id: string; active: boolean }[]
  for (const id of SEED_MODULES) {
    const m = modules.find((x) => x.id === id)
    if (!m) throw new Error(`module ${id} is not registered on this server`)
    if (!m.active) await run(OWNER, 'kernel.module_activate', { module_id: id })
  }

  const today = dayIn(d.timeZone, deps.now)
  const monday = mondayOf(today)

  // 3. The company's name.
  await run(OWNER, 'settings.update', { setting: 'company_name', value: d.companyName })

  // 4. Teammates: real members, named by themselves.
  for (const t of d.teammates) {
    people.set(t.handle, await deps.addTeammate(t))
    counts.teammates++
  }
  for (const t of d.teammates)
    await run(t.handle, 'members.set_my_name', { first_name: t.firstName, last_name: t.lastName })
  for (const g of d.groups) {
    await run(OWNER, 'members.group_create', {
      name: g.name,
      description: g.description,
      member_ids: g.members.map((h) => person(h).id),
    })
    counts.groups++
  }
  deps.log(`members: ${counts.teammates} teammates, ${counts.groups} groups`)

  // 5. Contacts: shared with the team, each held by one of us, with what happened.
  await run(OWNER, 'contacts.set_company_default_visibility', { visibility: 'team' })
  const companyName = new Map(d.companies.map((c) => [c.id, c.name]))
  for (const c of d.contacts) {
    const created = await run(c.owner, 'contacts.create', {
      ...contactFields(c, companyName.get(c.company)!),
      owner_id: person(c.owner).id,
      stage: 'inbox',
    })
    const id = field(created, ['id'], 'contacts.create')
    for (const l of c.logs) {
      await run(c.owner, 'contacts.log_contact', {
        id,
        on: addDays(today, l.day),
        via: l.via,
        how_it_went: l.howItWent,
        ...(l.stage === undefined ? {} : { stage: l.stage }),
        ...(l.nextFollowUpDay === undefined
          ? {}
          : { next_follow_up_on: addDays(today, l.nextFollowUpDay) }),
        ...(l.nextStep === undefined ? {} : { next_step: l.nextStep }),
        ...(l.latestStatus === undefined ? {} : { latest_status: l.latestStatus }),
      })
      counts.contactLogs++
    }
    // Where they stand now (a logged contact without a follow-up clears it).
    await run(c.owner, 'contacts.update', { id, ...contactState(c, today) })
    counts.contacts++
  }
  deps.log(`contacts: ${counts.contacts} people, ${counts.contactLogs} logged contacts`)

  // 6. Projects: the lead's own (shared with the company), tasks for others assigned by the lead.
  for (const p of d.projects) {
    const project = await run(p.lead, 'memory.create_project', { label: p.label, status: 'active' })
    const projectId = field(project, ['entityId'], 'memory.create_project')
    await run(p.lead, 'memory.set_project_deadline', {
      project_entity_id: projectId,
      target_date: `${addDays(today, p.deadlineDay)}T17:00:00.000Z`,
    })
    counts.projects++
    for (const t of p.tasks) {
      const due = addDays(today, t.dueDay)
      if (t.assignee === p.lead) {
        const task = await run(p.lead, 'memory.create_task', {
          title: `${t.title}, due ${due}`,
          project_entity_id: projectId,
        })
        if (t.done)
          await run(p.lead, 'memory.complete_task', {
            task_id: field(task, ['task', 'id'], 'memory.create_task'),
          })
      } else {
        const task = await run(p.lead, 'tasks.assign', {
          assignee_id: person(t.assignee).id,
          title: t.title,
          context: t.context ? `${p.label}: ${t.context}` : p.label,
          due_on: due,
        })
        if (t.done)
          await run(t.assignee, 'tasks.complete', { task_id: field(task, ['id'], 'tasks.assign') })
      }
      counts.tasks++
      if (t.done) counts.tasksDone++
    }
  }
  deps.log(`projects: ${counts.projects} with ${counts.tasks} tasks (${counts.tasksDone} done)`)

  // 7. Channels and their history, each message by its author.
  const channelIds = new Map<string, string>()
  for (const c of d.channels) {
    const created = await run(OWNER, 'messages.create_channel', {
      name: c.name,
      topic: c.topic,
      private: false,
    })
    channelIds.set(c.id, field(created, ['conversation', 'id'], 'messages.create_channel'))
    counts.channels++
  }
  for (const m of d.messages) {
    await run(m.author, 'messages.post', {
      conversation_id: channelIds.get(m.channel)!,
      body: m.body,
    })
    counts.messages++
  }
  deps.log(`messages: ${counts.messages} in ${counts.channels} channels`)

  // 8. Calendar: this week and next.
  for (const e of d.events) {
    const day = addDays(monday, e.week * 7 + (e.weekday - 1))
    await run(e.organizer, 'calendar.create_event', {
      title: e.title,
      all_day: false,
      start: `${day}T${e.start}`,
      end: `${day}T${e.end}`,
      time_zone: d.timeZone,
      visibility: 'company',
      ...(e.location === undefined ? {} : { location: e.location }),
      ...(e.notes === undefined ? {} : { notes: e.notes }),
      attendees: e.attendees.map((h) => ({ member_id: person(h).id })),
    })
    counts.events++
  }
  deps.log(`calendar: ${counts.events} events`)

  // 9. Drive: one company folder everyone may edit, the documents in it.
  const folder = await run(OWNER, 'drive.create_folder', { name: d.driveFolder })
  const folderId = field(folder, ['folder', 'id'], 'drive.create_folder')
  await run(OWNER, 'drive.set_sharing', {
    type: 'folder',
    id: folderId,
    grants: [{ subject: { kind: 'company' }, level: 'edit' }],
  })
  for (const doc of d.docs) {
    const file = await run(doc.author, 'drive.create_document', {
      name: doc.name,
      kind: 'md',
      content: doc.content,
      folder_id: folderId,
    })
    field(file, ['file', 'id'], 'drive.create_document')
    counts.docs++
  }
  deps.log(`drive: ${counts.docs} documents`)

  // 10. Brand voice.
  const b = d.brand
  const set = await run(OWNER, 'brand.set_create', {
    locale: b.locale,
    context: {
      mission: b.mission,
      audience: b.audience,
      register: b.register,
      toneAttributes: b.toneAttributes,
    },
  })
  const setId = field(set, ['id'], 'brand.set_create')
  for (const l of b.lexicon) {
    await run(OWNER, 'brand.lexicon_add', {
      setId,
      term: l.term,
      kind: l.kind,
      ...(l.replacement ? { replacement: l.replacement } : {}),
    })
  }
  for (const e of b.examples) {
    await run(OWNER, 'brand.example_add', {
      setId,
      contentType: e.contentType,
      situation: e.situation,
      body: e.body,
      label: e.label,
      rationale: e.rationale,
    })
  }
  for (const g of b.glossary)
    await run(OWNER, 'brand.glossary_add', { setId, term: g.term, definition: g.definition })
  await run(OWNER, 'brand.set_activate', { setId })
  counts.brandSets++

  // 11. Website pages, published.
  for (const p of d.pages) {
    await run(OWNER, 'website.create_page', {
      slug: p.slug,
      title: p.title,
      body: p.body,
      kind: 'page',
      visibility: 'private',
    })
    await run(OWNER, 'website.publish_page', { slug: p.slug, visibility: 'public' })
    counts.pages++
  }
  deps.log(`brand: voice set active · website: ${counts.pages} pages`)

  // 12. Shared memories: notes the company brain answers from.
  for (const m of d.memories) {
    await run(m.author, 'memory.create_text_file', { title: m.title, body: m.body, private: false })
    counts.memories++
  }
  deps.log(`memory: ${counts.memories} shared notes`)

  return counts
}
