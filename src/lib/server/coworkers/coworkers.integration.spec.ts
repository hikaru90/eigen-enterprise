import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CoworkerActor, CoworkerView } from './service'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { coworkerPrincipal } from '$lib/kernel/principals'
import { KernelRegistry } from '$lib/kernel/registry'
import { livePrincipalScope } from '$lib/server/kernel/principal-scope'

// Memory documents are Drive files (drizzle/0191): the live Drive keeps their bytes here.
process.env.DRIVE_STORAGE_DIR ??= mkdtempSync(join(tmpdir(), 'ee-memory-drive-'))

/**
 * AI co-workers on the test database (plan/phase-ai-coworkers.md C1): a
 * co-worker is a real `user` row that never signs in, the app's RLS scopes it
 * by its own id like a new member — its own rows and what is shared with the
 * company, never a person's private thought — and the org chart refuses
 * cycles in Postgres too.
 */
const DATABASE_URL = process.env.DATABASE_URL?.trim()

vi.mock('$lib/server/capture/capture-enrich-worker', () => ({
  scheduleCaptureEnrichWorker: () => {},
}))

describe.skipIf(!DATABASE_URL)('AI co-workers on Postgres', () => {
  const tag = `${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`
  const ana = `cw_ana_${tag}`
  const boss = `cw_admin_${tag}`
  let operator: postgres.Sql
  let db: typeof import('$lib/server/db')
  let svc: typeof import('./index')
  let ownerId: string
  let cw: CoworkerView
  let sharedProject: string
  let sharedTask: string
  let privateThought: string
  let privateNote: string
  let sharedNote: string
  let ownNote: string
  const created: string[] = []
  const admin: CoworkerActor = { id: boss, role: 'admin', kind: 'person' }

  beforeAll(async () => {
    db = await import('$lib/server/db')
    svc = await import('./index')
    operator = postgres(DATABASE_URL!, { max: 1, prepare: false })
    for (const [id, role] of [
      [ana, 'member'],
      [boss, 'admin'],
    ] as const) {
      await operator`
        insert into "user" (id, name, email, email_verified, onboarding_completed, role)
        values (${id}, ${`${role} ${tag}`}, ${`${id}@test.local`}, true, true, ${role})`
    }
    const [owner] = await operator`select id from "user" where role = 'owner'`
    if (!owner) throw new Error('the test database has no owner; a co-worker answers to the owner')
    ownerId = owner.id as string

    cw = await svc.createCoworker(admin, { templateId: 'marketing-manager', name: `Mara ${tag}` }, svc.coworkerDeps())
    created.push(cw.id)

    const { createUserDeclaredProject } = await import('$lib/server/memory/create-user-project')
    const { queueCapture } = await import('$lib/server/capture/queue-capture')
    const { linkThoughtToProject } = await import('$lib/server/memory/project-next-action')
    const { reconcileThoughtKeys } = await import('$lib/server/memory/shared-memory-keys')
    const { createTextFile } = await import('$lib/server/text-files/service')
    await db.withDbUser(ana, async () => {
      sharedProject = (await createUserDeclaredProject({ userId: ana, label: `Launch ${tag}` })).entityId
      sharedTask = (await queueCapture(ana, 'Write the launch post', { skipWorker: true, category: 'task' })).thoughtId
      privateThought = (await queueCapture(ana, 'I am thinking about quitting', { skipWorker: true })).thoughtId
      await linkThoughtToProject(ana, sharedProject, sharedTask)
      await reconcileThoughtKeys(ana, [sharedTask, privateThought])
      sharedNote = (await createTextFile(ana, { title: 'Launch plan', body: 'Monday' })).id
      privateNote = (await createTextFile(ana, { title: 'Diary', body: 'private', visibility: 'private' })).id
    })
    await db.withDbUser(cw.id, async () => {
      ownNote = (await createTextFile(cw.id, { title: 'Campaign ideas', body: 'three ideas', visibility: 'private' })).id
    })
    // Cold imports of Memory and Drive (documents are Drive files) outlast the 10s default.
  }, 30_000)

  afterAll(async () => {
    await operator`delete from "user" where id in ${operator([ana, boss, ...created])}`
    await operator.end()
    await db.closeAppDbPool()
  })

  it('is a member-role user of kind coworker with no account, no session and a reserved address', async () => {
    const [row] = await operator`select kind, role, email, email_verified, account_kind from "user" where id = ${cw.id}`
    expect(row).toMatchObject({ kind: 'coworker', role: 'member', email_verified: false, account_kind: 'production' })
    expect(row!.email).toBe(`${cw.slug}.${cw.id.slice(0, 8)}@coworker.invalid`)
    const [{ n: accounts }] = await operator`select count(*)::int as n from account where user_id = ${cw.id}`
    const [{ n: sessions }] = await operator`select count(*)::int as n from session where user_id = ${cw.id}`
    expect([accounts, sessions]).toEqual([0, 0])
    expect(cw).toMatchObject({ enabled: true, title: 'Marketing Manager', accountableHuman: { id: ownerId, reason: 'owner' } })
    const [person] = await operator`select kind from "user" where id = ${ana}`
    expect(person!.kind).toBe('human')
  })

  it('can never sign in: the session hook refuses it; a person passes', async () => {
    const { refuseCoworkerSession } = await import('$lib/server/auth/coworker-sign-in')
    await expect(refuseCoworkerSession(cw.id)).rejects.toThrow(/AI co-worker/)
    await expect(refuseCoworkerSession(ana)).resolves.toBeUndefined()
  })

  it('the brain never acts as a co-worker (no person behind it)', async () => {
    const { personFor } = await import('$lib/server/auth/user-role')
    await expect(personFor(cw.id)).resolves.toBeNull()
    await expect(personFor(ana)).resolves.toEqual({ id: ana, roles: ['member'] })
  })

  it('its RLS scope is its own id: its own rows and company-shared rows, never a person’s private thought or note', async () => {
    const registry = new KernelRegistry({ principalScope: livePrincipalScope })
    registry.register({
      name: 'probe.visible',
      module: 'probe',
      summary: 'What the calling member can see',
      auditClass: 'read',
      inputSchema: z.object({}).strict(),
      permission: { roles: ['member'] },
      handler: async () => {
        const rows = await db.getDb().execute(
          sql`select
            current_setting('app.current_user_id', true) as me,
            (select coalesce(array_agg(id::text order by id), '{}') from canonical_entity where user_id = ${ana}) as projects,
            (select coalesce(array_agg(id::text order by id), '{}') from thought where user_id = ${ana}) as thoughts,
            (select coalesce(array_agg(drive_file_id order by drive_file_id), '{}') from memory_document where user_id = ${ana}) as notes,
            (select coalesce(array_agg(drive_file_id order by drive_file_id), '{}') from memory_document where user_id = ${cw.id}) as own_notes`,
        )
        return [...rows][0]
      },
    })
    const seen = (await registry.execute('probe.visible', {}, { principal: coworkerPrincipal(cw.id, cw.agentId), requestId: 'r-cw' })) as {
      me: string
      projects: string[]
      thoughts: string[]
      notes: string[]
      own_notes: string[]
    }
    expect(seen.me).toBe(cw.id)
    expect(seen.projects).toEqual([sharedProject])
    expect(seen.thoughts).toEqual([sharedTask])
    expect(seen.thoughts).not.toContain(privateThought)
    expect(seen.notes).toEqual([sharedNote])
    expect(seen.notes).not.toContain(privateNote)
    expect(seen.own_notes).toEqual([ownNote])
    // And the person never sees the co-worker's private note.
    const ana_ = await db.withDbUser(ana, (scoped) =>
      scoped.execute(sql`select coalesce(array_agg(drive_file_id), '{}') as ids from memory_document where user_id = ${cw.id}`),
    )
    expect(([...ana_][0] as { ids: string[] }).ids).toEqual([])
  })

  it('members list it with its kind; set_role refuses it and members.remove points to coworkers.remove', async () => {
    const { dbMemberStore } = await import('$lib/server/members/db-store')
    const { setMemberRole, removeMember } = await import('$lib/server/members/service')
    const listed = (await dbMemberStore.listMembers()).find((m) => m.id === cw.id)
    expect(listed).toMatchObject({ kind: 'coworker', role: 'member' })
    const actor = { id: boss, role: 'admin' as const }
    await expect(setMemberRole(actor, { userId: cw.id, role: 'admin' }, { store: dbMemberStore })).rejects.toMatchObject({
      code: 'coworker_protected',
    })
    await expect(removeMember(actor, { userId: cw.id }, { store: dbMemberStore })).rejects.toThrow(/coworkers\.remove/)
    // The write path refuses it too, whatever calls it.
    await expect(dbMemberStore.setRole(cw.id, 'admin')).rejects.toThrow(/matched 0 rows/)
    const [row] = await operator`select role from "user" where id = ${cw.id}`
    expect(row!.role).toBe('member')
  })

  it('create refuses a model outside the chat pool and leaves nothing behind', async () => {
    const name = `Nope ${tag}`
    await expect(
      svc.createCoworker(admin, { templateId: 'designer', name, modelId: 'anthropic/not-vetted' }, svc.coworkerDeps()),
    ).rejects.toMatchObject({ code: 'invalid_model' })
    const rows = await operator`select id from "user" where name = ${name}`
    expect(rows).toHaveLength(0)
  })

  it('the org chart: everyone with kind and seat; cycles and self-reporting are refused', async () => {
    const gtm = await svc.createCoworker(
      admin,
      { templateId: 'go-to-market-manager', name: `Gus ${tag}`, reportsToUserId: cw.id },
      svc.coworkerDeps(),
    )
    created.push(gtm.id)
    await svc.setOrgPosition(admin, { userId: cw.id, reportsToUserId: ana }, svc.coworkerDeps())
    expect(await svc.accountableHumanFor(gtm.id)).toMatchObject({ id: ana, reason: 'chain' })
    await expect(svc.setOrgPosition(admin, { userId: ana, reportsToUserId: gtm.id }, svc.coworkerDeps())).rejects.toMatchObject({
      code: 'org_cycle',
    })
    await expect(svc.setOrgPosition(admin, { userId: ana, reportsToUserId: ana }, svc.coworkerDeps())).rejects.toMatchObject({
      code: 'org_cycle',
    })
    // The database refuses self-reporting on its own, too.
    await expect(
      operator`insert into org_position (user_id, reports_to_user_id, updated_by) values (${boss}, ${boss}, ${boss})`,
    ).rejects.toThrow(/org_position_not_self/)
    const { people } = await svc.orgChart()
    const byId = new Map(people.map((p) => [p.id, p]))
    expect(byId.get(ana)).toMatchObject({ kind: 'human', reportsToUserId: null, accountableHuman: null })
    expect(byId.get(cw.id)).toMatchObject({ kind: 'coworker', title: 'Marketing Manager', reportsToUserId: ana, accountableHuman: { id: ana } })
    expect(byId.get(gtm.id)).toMatchObject({ kind: 'coworker', reportsToUserId: cw.id, enabled: true })
    expect((await svc.listEnabledCoworkers()).map((c) => c.id)).toEqual(expect.arrayContaining([cw.id, gtm.id]))
  })

  it('remove keeps the user row and what it wrote, takes it out of members and the chart, and moves its reports up', async () => {
    const gtm = created[1]!
    const removed = await svc.removeCoworker(admin, { userId: cw.id }, svc.coworkerDeps())
    expect(removed).toMatchObject({ enabled: false, accountableHuman: null })
    expect(removed.removedAt).not.toBeNull()
    const [row] = await operator`select kind from "user" where id = ${cw.id}`
    expect(row!.kind).toBe('coworker')
    const [{ n: notes }] = await operator`select count(*)::int as n from memory_document where user_id = ${cw.id}`
    expect(notes).toBe(1)
    const { dbMemberStore } = await import('$lib/server/members/db-store')
    expect((await dbMemberStore.listMembers()).map((m) => m.id)).not.toContain(cw.id)
    const { people } = await svc.orgChart()
    expect(people.map((p) => p.id)).not.toContain(cw.id)
    expect(people.find((p) => p.id === gtm)).toMatchObject({ reportsToUserId: ana, accountableHuman: { id: ana } })
    expect((await svc.listEnabledCoworkers()).map((c) => c.id)).not.toContain(cw.id)
  })

  it('co-workers are no seat', async () => {
    const { countSeats } = await import('$lib/server/fleet/seat-count')
    const [{ n }] = await operator`select count(*)::int as n from "user" where account_kind = 'production' and kind = 'human'`
    expect(await countSeats()).toBe(n)
  })
})
