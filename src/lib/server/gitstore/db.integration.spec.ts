import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canonicalYaml, parseYaml } from './canonical'
import { git, tempDir } from './test-helpers'

/**
 * G0 proof on real Postgres: groups created through the existing service go
 * file-first; wiping member_group + member_group_member and rebuilding from
 * the repo gives identical results; an external edit is picked up.
 */
const hasDb = Boolean(process.env.DATABASE_URL)

describe.skipIf(!hasDb)('groups: git-native proof on Postgres', () => {
  const suffix = `gs_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`
  const owner = `${suffix}_owner`
  const ana = `${suffix}_ana`
  const ben = `${suffix}_ben`
  type Mods = {
    db: typeof import('$lib/server/db/auth-db')
    auth: typeof import('$lib/server/db/auth.schema')
    team: typeof import('$lib/server/db/team.schema')
    gs: typeof import('./db')
    live: typeof import('./live')
    groups: typeof import('$lib/server/members/groups')
    reads: typeof import('$lib/server/members/groups-db-store')
    store: typeof import('./surfaces/groups')
  }
  let m: Mods

  beforeAll(async () => {
    m = {
      db: await import('$lib/server/db/auth-db'),
      auth: await import('$lib/server/db/auth.schema'),
      team: await import('$lib/server/db/team.schema'),
      gs: await import('./db'),
      live: await import('./live'),
      groups: await import('$lib/server/members/groups'),
      reads: await import('$lib/server/members/groups-db-store'),
      store: await import('./surfaces/groups'),
    }
    for (const id of [owner, ana, ben]) {
      await m.db.authDb
        .insert(m.auth.user)
        .values({
          id,
          name: `User ${id.slice(-3)}`,
          email: `${id}@test.local`,
          emailVerified: true,
        })
    }
  })

  afterAll(async () => {
    const { inArray } = await import('drizzle-orm')
    await m.db.authDb.delete(m.auth.user).where(inArray(m.auth.user.id, [owner, ana, ben]))
  })

  it('create via the service → wipe tables → rebuild from the repo → identical; external edit flows in', async () => {
    const { sql } = await import('drizzle-orm')
    // these tests own the group tables for their duration (shared test DB)
    await m.db.authDb.delete(m.team.memberGroup)
    const framework = m.live.buildFramework(tempDir('pg'))
    await framework.engine.open()
    await framework.reconcile({ recover: true })
    const deps = {
      groups: m.store.gitGroupStore({
        framework,
        index: m.gs.dbGroupIndex,
        reads: m.reads.dbGroupStore,
        author: m.live.liveAuthor,
      }),
      audit: async () => undefined,
    }
    const actor = { id: owner, role: 'owner' as const }
    const sales = await m.groups.createGroup(
      actor,
      { name: `Sales ${suffix}`, memberIds: [ben, ana] },
      deps,
    )
    const dev = await m.groups.createGroup(
      actor,
      { name: `Dev ${suffix}`, description: 'Builds', memberIds: [ana] },
      deps,
    )
    await m.groups.updateGroup(actor, { groupId: dev.id, memberIds: [ana, owner, ben] }, deps)
    const dir = framework.engine.dir
    expect(git(dir, 'log', '-1', '--format=%an <%ae>')).toBe(`User ner <${owner}@test.local>`)
    expect(await m.gs.dbWatermarks.get('groups')).toBe(await framework.engine.head())

    const before = await m.groups.listGroups(actor, deps)
    const rowsBefore = await m.gs.dbGroupIndex.all()
    expect(before.map((g) => g.name).sort()).toEqual([`Dev ${suffix}`, `Sales ${suffix}`])

    await m.db.authDb.execute(sql`DELETE FROM member_group_member`)
    await m.db.authDb.execute(sql`DELETE FROM member_group`)
    expect(await m.groups.listGroups(actor, deps)).toEqual([])

    const [report] = await framework.rebuildIndex('groups')
    expect(report).toMatchObject({ rows: 2, problems: [] })
    expect(await m.groups.listGroups(actor, deps)).toEqual(before)
    expect(await m.gs.dbGroupIndex.all()).toEqual(rowsBefore)

    // external edit (a pulled commit): rename + membership change
    const path = git(dir, 'ls-tree', '--name-only', 'HEAD', 'groups/')
      .split('\n')
      .find((p) => p.startsWith('groups/sales'))!
    const file = parseYaml(git(dir, 'show', `HEAD:${path}`)) as Record<string, unknown>
    writeFileSync(
      join(dir, path),
      canonicalYaml({ ...file, name: `Sales EU ${suffix}`, members: [ana] }),
    )
    git(dir, 'commit', '-q', '-am', 'edited on GitHub')
    await framework.reconcile()
    expect(await m.groups.listGroups(actor, deps)).toContainEqual({
      id: sales.id,
      name: `Sales EU ${suffix}`,
      description: '',
      memberIds: [ana],
    })

    await m.db.authDb.delete(m.team.memberGroup)
  })
})
