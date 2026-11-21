import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { delegatedPrincipal } from '$lib/kernel/principals'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext } from '$lib/kernel/types'
import { livePrincipalScope } from '$lib/server/kernel/principal-scope'
import { createMemoryTools } from '../../../../modules/memory/tools'
import { ORCHESTRATOR_AGENT_ID } from '../../../../modules/orchestrator/brain'

/**
 * Shared Memory (plan/shared-memory-voice-agent-tools.md §1) on the test
 * database, as the app's RLS role: projects and notes are shared with every
 * member by default; a Private one is its owner's alone (no admin or owner
 * override); tasks follow their project; thoughts and tasks outside projects
 * stay private; nobody but the owner changes a project or note.
 */
const DATABASE_URL = process.env.DATABASE_URL?.trim()

vi.mock('$lib/server/capture/capture-enrich-worker', () => ({
  scheduleCaptureEnrichWorker: () => {},
}))

type Envelope = { k?: string }
const keyOf = (ciphertext: string | null): string => (JSON.parse(ciphertext ?? '{}') as Envelope).k ?? 'person'

describe.skipIf(!DATABASE_URL)('shared projects and notes', () => {
  const tag = `${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`
  const ana = `share_ana_${tag}`
  const ben = `share_ben_${tag}`
  const boss = `share_admin_${tag}`
  let operator: postgres.Sql
  let db: typeof import('$lib/server/db')
  let sharedProject: string
  let privateProject: string
  let sharedTask: string
  let privateProjectTask: string
  let looseTask: string
  let rawThought: string
  let sharedNote: string
  let privateNote: string

  const registry = new KernelRegistry({ principalScope: livePrincipalScope })
  for (const tool of createMemoryTools()) registry.register(tool)
  const humanCtx = (id: string, roles = ['member']): ToolContext => ({
    principal: { id, kind: 'human', roles },
    requestId: `r-${id}`,
  })
  const brainFor = (id: string): ToolContext => ({
    principal: delegatedPrincipal({ id, roles: ['member'] }, ORCHESTRATOR_AGENT_ID),
    requestId: `rb-${id}`,
  })

  const visibleTo = async (reader: string) => {
    const rows = await db.withDbUser(reader, (scoped) =>
      scoped.execute(
        sql`select
          (select coalesce(array_agg(id::text order by id), '{}') from canonical_entity where user_id = ${ana}) as projects,
          (select coalesce(array_agg(id::text order by id), '{}') from thought where user_id = ${ana}) as thoughts,
          (select coalesce(array_agg(id::text order by id), '{}') from text_file where user_id = ${ana}) as notes`,
      ),
    )
    return [...rows][0] as { projects: string[]; thoughts: string[]; notes: string[] }
  }

  beforeAll(async () => {
    db = await import('$lib/server/db')
    operator = postgres(DATABASE_URL!, { max: 1, prepare: false })
    for (const [id, role] of [
      [ana, 'member'],
      [ben, 'member'],
      [boss, 'admin'],
    ] as const) {
      await operator`
        insert into "user" (id, name, email, email_verified, onboarding_completed, role)
        values (${id}, ${`${role} ${id.slice(6, 9)}`}, ${`${id}@test.local`}, true, true, ${role})`
    }
    const { createUserDeclaredProject } = await import('$lib/server/memory/create-user-project')
    const { queueCapture } = await import('$lib/server/capture/queue-capture')
    const { linkThoughtToProject } = await import('$lib/server/memory/project-next-action')
    const { reconcileThoughtKeys } = await import('$lib/server/memory/shared-memory-keys')
    const { createTextFile } = await import('$lib/server/text-files/service')
    await db.withDbUser(ana, async () => {
      sharedProject = (await createUserDeclaredProject({ userId: ana, label: `Website relaunch ${tag}` })).entityId
      privateProject = (
        await createUserDeclaredProject({ userId: ana, label: `Job search ${tag}`, visibility: 'private' })
      ).entityId
      const task = async (text: string) =>
        (await queueCapture(ana, text, { skipWorker: true, category: 'task' })).thoughtId
      sharedTask = await task('Draft the new landing page copy')
      privateProjectTask = await task('Update my CV')
      looseTask = await task('Buy a birthday present')
      rawThought = (await queueCapture(ana, 'I worry the relaunch slips', { skipWorker: true })).thoughtId
      await linkThoughtToProject(ana, sharedProject, sharedTask)
      await linkThoughtToProject(ana, privateProject, privateProjectTask)
      // The raw thought mentions the shared project (enrichment would link it): still private.
      await linkThoughtToProject(ana, sharedProject, rawThought, 'ingest')
      await reconcileThoughtKeys(ana, [sharedTask, privateProjectTask, rawThought])
      sharedNote = (await createTextFile(ana, { title: 'Launch checklist', body: 'DNS, analytics, redirects' })).id
      privateNote = (
        await createTextFile(ana, { title: 'Salary notes', body: 'my number', visibility: 'private' })
      ).id
    })
  })

  afterAll(async () => {
    await operator`delete from "user" where id in (${ana}, ${ben}, ${boss})`
    await operator.end()
    await db.closeAppDbPool()
  })

  it('projects and notes start shared; Private is asked for', async () => {
    const rows = await operator`
      select id::text, visibility from canonical_entity where id in (${sharedProject}, ${privateProject})
      union all
      select id::text, visibility from text_file where id in (${sharedNote}, ${privateNote})`
    const byId = new Map(rows.map((r) => [r.id as string, r.visibility as string]))
    expect(byId.get(sharedProject)).toBe('company')
    expect(byId.get(privateProject)).toBe('private')
    expect(byId.get(sharedNote)).toBe('company')
    expect(byId.get(privateNote)).toBe('private')
  })

  it('a colleague sees the shared project and its task, never the private project, loose tasks or thoughts', async () => {
    for (const reader of [ben, boss]) {
      const seen = await visibleTo(reader)
      expect(seen.projects).toEqual([sharedProject])
      expect(seen.thoughts).toEqual([sharedTask])
      expect(seen.notes).toEqual([sharedNote])
    }
    const own = await visibleTo(ana)
    expect(own.thoughts.sort()).toEqual([sharedTask, privateProjectTask, looseTask, rawThought].sort())
  })

  it('shared rows are company-keyed, private rows keep the owner’s key', async () => {
    const [t] = await operator`select normalized_text_encrypted as c from thought where id = ${sharedTask}`
    const [p] = await operator`select normalized_text_encrypted as c from thought where id = ${privateProjectTask}`
    const [r] = await operator`select normalized_text_encrypted as c from thought where id = ${rawThought}`
    const [n] = await operator`select body_text_encrypted as c from text_file where id = ${sharedNote}`
    const [pn] = await operator`select body_text_encrypted as c from text_file where id = ${privateNote}`
    expect(keyOf(t.c)).toBe('company')
    expect(keyOf(n.c)).toBe('company')
    expect(keyOf(p.c)).toBe('person')
    expect(keyOf(r.c)).toBe('person')
    expect(keyOf(pn.c)).toBe('person')
  })

  it('a colleague reads the shared project with its tasks and the shared note through the registry', async () => {
    const projects = (await registry.execute('memory.list_projects', {}, humanCtx(ben))) as {
      projects: Array<{ entityId: string; label: string; owner: { id: string }; editable: boolean; tasks: Array<{ summary: string }> }>
    }
    const team = projects.projects.find((p) => p.entityId === sharedProject)
    expect(team).toMatchObject({ owner: { id: ana }, editable: false })
    expect(team?.tasks.map((t) => t.summary)).toEqual(['Draft the new landing page copy'])
    expect(JSON.stringify(projects)).not.toContain(privateProject)
    expect(JSON.stringify(projects)).not.toContain('Update my CV')

    const timeline = (await registry.execute(
      'memory.get_project_timeline',
      { project_entity_id: sharedProject },
      brainFor(ben),
    )) as { project: { tasks: Array<{ summary: string }>; owner: { id: string } } }
    expect(timeline.project.owner.id).toBe(ana)
    expect(timeline.project.tasks.map((t) => t.summary)).toEqual(['Draft the new landing page copy'])
    await expect(
      registry.execute('memory.get_project_timeline', { project_entity_id: privateProject }, brainFor(ben)),
    ).rejects.toThrow(/not found/i)

    const note = (await registry.execute('memory.get_text_file', { text_file_id: sharedNote }, brainFor(ben))) as {
      textFile: { body: string; ownerId: string; editable: boolean }
    }
    expect(note.textFile).toMatchObject({ body: 'DNS, analytics, redirects', ownerId: ana, editable: false })
    await expect(
      registry.execute('memory.get_text_file', { text_file_id: privateNote }, brainFor(ben)),
    ).rejects.toThrow(/not found/i)

    const found = (await registry.execute('memory.search_text_files', { query: 'checklist salary number' }, brainFor(ben))) as {
      results: Array<{ id: string }>
    }
    expect(found.results.map((r) => r.id)).toContain(sharedNote)
    expect(found.results.map((r) => r.id)).not.toContain(privateNote)

    const thoughts = await registry.execute('memory.retrieve_thoughts', { order: 'created_at', detail: 'full' }, brainFor(ben))
    expect(JSON.stringify(thoughts)).not.toContain(sharedTask)
  })

  it('a colleague cannot change the project, hang a task on it, or change the note', async () => {
    const { updateProjectLabel } = await import('$lib/server/memory/project-list')
    await expect(
      db.withDbUser(ben, () => updateProjectLabel(ben, sharedProject, 'Hijacked')),
    ).rejects.toThrow()
    const changed = await db.withDbUser(ben, (scoped) =>
      scoped.execute(sql`update canonical_entity set label = 'Hijacked' where id = ${sharedProject} returning id`),
    )
    expect([...changed]).toHaveLength(0)

    const { queueCapture } = await import('$lib/server/capture/queue-capture')
    const benTask = await db.withDbUser(ben, () =>
      queueCapture(ben, 'Sneak a task in', { skipWorker: true, category: 'task' }),
    )
    await expect(
      db.withDbUser(ben, (scoped) =>
        scoped.execute(
          sql`insert into thought_entity (thought_id, entity_id, user_id) values (${benTask.thoughtId}, ${sharedProject}, ${ben})`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/row-level security/) } })

    await expect(
      registry.execute('memory.update_text_file', { text_file_id: sharedNote, body: 'overwritten' }, humanCtx(ben)),
    ).rejects.toThrow(/read-only|not yours|owned by/i)
    await expect(
      registry.execute('memory.set_project_visibility', { project_entity_id: sharedProject, private: true }, humanCtx(ben)),
    ).rejects.toThrow(/read-only|not yours|owned by/i)
    const [kept] = await operator`select label from canonical_entity where id = ${sharedProject}`
    expect(kept.label).toBe(`Website relaunch ${tag}`)
  })

  it('the assistant may make things private for the person, never share them', async () => {
    await expect(
      registry.execute('memory.set_text_file_visibility', { text_file_id: privateNote, private: false }, brainFor(ana)),
    ).rejects.toMatchObject({ code: 'permission_denied' })
    const [still] = await operator`select visibility from text_file where id = ${privateNote}`
    expect(still.visibility).toBe('private')
  })

  it('making the project private hides it and its tasks at once and re-keys them; sharing again brings them back', async () => {
    await registry.execute('memory.set_project_visibility', { project_entity_id: sharedProject, private: true }, humanCtx(ana))
    const hidden = await visibleTo(ben)
    expect(hidden.projects).toEqual([])
    expect(hidden.thoughts).toEqual([])
    const [t] = await operator`select normalized_text_encrypted as c from thought where id = ${sharedTask}`
    expect(keyOf(t.c)).toBe('person')

    // The owner still reads it (own key).
    const own = (await registry.execute('memory.list_projects', {}, humanCtx(ana))) as {
      projects: Array<{ entityId: string; visibility: string; editable: boolean; tasks: Array<{ summary: string }> }>
    }
    expect(own.projects.find((p) => p.entityId === sharedProject)).toMatchObject({
      visibility: 'private',
      editable: true,
      tasks: [expect.objectContaining({ summary: 'Draft the new landing page copy' })],
    })

    await registry.execute('memory.set_project_visibility', { project_entity_id: sharedProject, private: false }, humanCtx(ana))
    expect((await visibleTo(ben)).thoughts).toEqual([sharedTask])
    const [again] = await operator`select normalized_text_encrypted as c from thought where id = ${sharedTask}`
    expect(keyOf(again.c)).toBe('company')
  })

  it('a private note is the owner’s alone; toggling re-keys its body both ways', async () => {
    await registry.execute('memory.set_text_file_visibility', { text_file_id: sharedNote, private: true }, humanCtx(ana))
    expect((await visibleTo(ben)).notes).toEqual([])
    expect((await visibleTo(boss)).notes).toEqual([])
    const [n] = await operator`select body_text_encrypted as c from text_file where id = ${sharedNote}`
    expect(keyOf(n.c)).toBe('person')
    const back = (await registry.execute(
      'memory.set_text_file_visibility',
      { text_file_id: sharedNote, private: false },
      humanCtx(ana),
    )) as { textFileId: string; visibility: string }
    expect(back).toEqual({ textFileId: sharedNote, visibility: 'company' })
    const [n2] = await operator`select body_text_encrypted as c from text_file where id = ${sharedNote}`
    expect(keyOf(n2.c)).toBe('company')
    expect((await visibleTo(ben)).notes).toEqual([sharedNote])
  })

  it('the start-up re-key seals rows shared before they were re-keyed (the migration’s backfill)', async () => {
    const { queueCapture } = await import('$lib/server/capture/queue-capture')
    const { reconcileAllMemoryKeysOf } = await import('$lib/server/memory/shared-memory-keys')
    const legacy = await db.withDbUser(ana, () =>
      queueCapture(ana, 'Book the launch venue', { skipWorker: true, category: 'task' }),
    )
    // Linked behind the app's back, as existing rows were when 0164 shared their project.
    await operator`insert into thought_entity (thought_id, entity_id, user_id) values (${legacy.thoughtId}, ${sharedProject}, ${ana})`
    const [before] = await operator`select normalized_text_encrypted as c from thought where id = ${legacy.thoughtId}`
    expect(keyOf(before.c)).toBe('person')
    // A colleague can see the row but not open it yet — loud, not garbage.
    const { decryptTenantValue } = await import('$lib/server/crypto/tenant-encryption')
    await expect(
      db.withDbUser(ben, () =>
        decryptTenantValue({ userId: ana, table: 'thought', column: 'normalized_text', ciphertext: before.c }),
      ),
    ).rejects.toThrow(/another person.*not shared/)

    const result = await db.withDbUser(ana, () => reconcileAllMemoryKeysOf(ana))
    expect(result.thoughts).toBeGreaterThanOrEqual(1)
    const [after] = await operator`select normalized_text_encrypted as c from thought where id = ${legacy.thoughtId}`
    expect(keyOf(after.c)).toBe('company')
    const again = await db.withDbUser(ana, () => reconcileAllMemoryKeysOf(ana))
    expect(again).toEqual({ thoughts: 0, notes: 0 })
  })

  it('the owner’s edits keep a shared note readable for colleagues', async () => {
    await registry.execute('memory.update_text_file', { text_file_id: sharedNote, body: 'DNS, analytics, redirects, SSL' }, humanCtx(ana))
    const note = (await registry.execute('memory.get_text_file', { text_file_id: sharedNote }, humanCtx(ben))) as {
      textFile: { body: string }
    }
    expect(note.textFile.body).toBe('DNS, analytics, redirects, SSL')
  })
})
