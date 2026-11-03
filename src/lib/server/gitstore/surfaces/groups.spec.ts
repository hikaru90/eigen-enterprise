import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createGroup,
  deleteGroup,
  listGroups,
  updateGroup,
  type GroupDeps,
} from '$lib/server/members/groups'
import { canonicalYaml, parseYaml } from '../canonical'
import { GitEngine } from '../engine'
import { exportDbToRepo } from '../export'
import {
  FormatVersionError,
  IndexFramework,
  memoryWatermarks,
  type SurfaceAdapter,
} from '../framework'
import { git, tempDir } from '../test-helpers'
import {
  GROUP_FORMAT,
  gitGroupStore,
  groupsAdapter,
  memoryGroupIndex,
  type GroupEntity,
} from './groups'

const OWNER = { id: 'u-owner', role: 'owner' as const }
const MEMBERS = ['u-owner', 'u-ana', 'u-ben', 'u-cy']
const authors: Record<string, { name: string; email: string }> = {
  'u-owner': { name: 'Olga Owner', email: 'olga@acme.test' },
}

async function setup(dir = tempDir('groups')) {
  const engine = new GitEngine({ dir })
  await engine.open()
  const watermarks = memoryWatermarks()
  const index = memoryGroupIndex(MEMBERS)
  const framework = new IndexFramework(engine, watermarks, () => undefined)
  const adapter = groupsAdapter(index)
  framework.register(adapter)
  await framework.reconcile({ recover: true })
  const store = gitGroupStore({
    framework,
    index,
    reads: index.reads,
    author: async (id) => authors[id] ?? { name: `agent ${id}`, email: `${id}@agents.eigen.local` },
  })
  const deps: GroupDeps = { groups: store, audit: async () => undefined }
  return { engine, framework, index, deps, watermarks, adapter }
}

const read = (dir: string, p: string) => git(dir, 'show', `HEAD:${p}`)

describe('groups on the git-native framework', () => {
  it('writes go file-first: groups/<slug>.yaml with format+version, one commit per change, authored by the actor', async () => {
    const { engine, deps, watermarks } = await setup()
    const sales = await createGroup(
      OWNER,
      { name: 'Sales', description: 'Sells', memberIds: ['u-ben', 'u-ana'] },
      deps,
    )
    const file = parseYaml(read(engine.dir, 'groups/sales.yaml')) as Record<string, unknown>
    expect(file).toMatchObject({
      format: GROUP_FORMAT,
      version: 1,
      id: sales.id,
      name: 'Sales',
      description: 'Sells',
      createdBy: 'u-owner',
      members: ['u-ben', 'u-ana'],
    })
    expect(git(engine.dir, 'log', '-1', '--format=%an|%s')).toBe('Olga Owner|groups: create Sales')
    // byte-canonical file
    expect(read(engine.dir, 'groups/sales.yaml') + '\n').toBe(canonicalYaml(file))
    // watermark follows our own commits
    expect(await watermarks.get('groups')).toBe(await engine.head())

    await updateGroup(OWNER, { groupId: sales.id, name: 'Revenue' }, deps)
    expect(git(engine.dir, 'ls-tree', '--name-only', 'HEAD', 'groups/')).toBe('groups/revenue.yaml')
    await updateGroup(
      { id: 'agent-7', role: 'admin' },
      { groupId: sales.id, memberIds: ['u-cy'] },
      deps,
    )
    expect(git(engine.dir, 'log', '-1', '--format=%an <%ae>')).toBe(
      'agent agent-7 <agent-7@agents.eigen.local>',
    )
    await deleteGroup(OWNER, { groupId: sales.id }, deps)
    expect(git(engine.dir, 'ls-tree', '--name-only', 'HEAD', 'groups/')).toBe('')
    expect(await listGroups(OWNER, deps)).toEqual([])
  })

  it('slug clash → <slug>-<id8>.yaml', async () => {
    const { engine, deps } = await setup()
    await createGroup(OWNER, { name: 'R&D' }, deps)
    const b = await createGroup(OWNER, { name: 'R D' }, deps)
    expect(git(engine.dir, 'ls-tree', '--name-only', 'HEAD', 'groups/').split('\n')).toEqual([
      `groups/r-d-${b.id.slice(0, 8)}.yaml`,
      'groups/r-d.yaml',
    ])
  })

  it('rebuild from scratch: wipe the index → rebuild from the repo → identical results', async () => {
    const { deps, index, framework } = await setup()
    await createGroup(OWNER, { name: 'Sales', memberIds: ['u-ben', 'u-ana'] }, deps)
    const dev = await createGroup(
      OWNER,
      { name: 'Dev', description: 'Builds', memberIds: ['u-cy'] },
      deps,
    )
    await updateGroup(OWNER, { groupId: dev.id, memberIds: ['u-cy', 'u-owner'] }, deps)
    const before = await listGroups(OWNER, deps)
    const byId = (rows: GroupEntity[]) => [...rows].sort((x, y) => (x.id < y.id ? -1 : 1))
    const rowsBefore = byId(await index.all())
    index.rows.clear()
    expect(await listGroups(OWNER, deps)).toEqual([])
    const [report] = await framework.rebuildIndex('groups')
    expect(report).toMatchObject({ surface: 'groups', rows: 2, problems: [] })
    expect(await listGroups(OWNER, deps)).toEqual(before)
    expect(byId(await index.all())).toEqual(rowsBefore)
  })

  it('fresh server: a clone of the repo rebuilds the same groups', async () => {
    const a = await setup()
    await createGroup(OWNER, { name: 'Sales', memberIds: ['u-ana'] }, a.deps)
    const clone = tempDir('clone')
    git(a.engine.dir, 'clone', '-q', a.engine.dir, clone)
    const b = await setup(clone)
    expect(await listGroups(OWNER, b.deps)).toEqual(await listGroups(OWNER, a.deps))
  })

  it('external edit (simulated pull) → reconcile → index reflects it; bad files are reported, not fatal', async () => {
    const { engine, deps, framework } = await setup()
    const sales = await createGroup(OWNER, { name: 'Sales', memberIds: ['u-ana'] }, deps)
    // someone edits the YAML on GitHub; the server fast-forwards to it
    const text = read(engine.dir, 'groups/sales.yaml')
    const edited = {
      ...(parseYaml(text) as object),
      name: 'Sales EU',
      members: ['u-ana', 'u-ben', 'u-ghost'],
    }
    writeFileSync(join(engine.dir, 'groups/sales.yaml'), canonicalYaml(edited))
    writeFileSync(
      join(engine.dir, 'groups/broken.yaml'),
      'format: eigen.group\nversion: 1\nname: [\n',
    )
    git(engine.dir, 'add', '.')
    git(engine.dir, 'commit', '-q', '-m', 'edit on GitHub')
    await expect(framework.reconcile()).rejects.toThrow(FormatVersionError) // broken yaml has no readable header
    git(engine.dir, 'rm', '-q', 'groups/broken.yaml')
    git(engine.dir, 'commit', '-q', '-m', 'drop broken')
    const [r] = await framework.reconcile()
    expect(r!.problems).toEqual(['group Sales EU: unknown member u-ghost skipped'])
    expect(await listGroups(OWNER, deps)).toEqual([
      { id: sales.id, name: 'Sales EU', description: '', memberIds: ['u-ana', 'u-ben'] },
    ])
    // nothing changed since → reconcile is a no-op
    expect(await framework.reconcile()).toEqual([])
  })

  it('crash between file write and commit: boot reconcile commits and re-indexes', async () => {
    const a = await setup()
    await createGroup(OWNER, { name: 'Sales' }, a.deps)
    const g = (await a.index.all())[0]!
    // the process died after writing the file, before commit + index update
    writeFileSync(
      join(a.engine.dir, 'groups/sales.yaml'),
      canonicalYaml({
        ...(parseYaml(read(a.engine.dir, 'groups/sales.yaml')) as object),
        description: 'late',
      }),
    )
    const engine2 = new GitEngine({ dir: a.engine.dir })
    const fw2 = new IndexFramework(engine2, a.watermarks, () => undefined)
    fw2.register(groupsAdapter(a.index))
    await engine2.open()
    await fw2.reconcile({ recover: true })
    expect((await a.index.get(g.id))?.description).toBe('late')
    expect(git(a.engine.dir, 'status', '--porcelain')).toBe('')
  })

  it('format versions: newer files refused loudly; a registered v1 → v2 migration runs as one commit', async () => {
    const { engine, deps, index, watermarks } = await setup()
    await createGroup(
      OWNER,
      { name: 'Sales', description: 'old field', memberIds: ['u-ana'] },
      deps,
    )
    await createGroup(OWNER, { name: 'Dev' }, deps)

    // test-only v2: `description` is renamed to `summary`
    const base = groupsAdapter(index)
    const v2: SurfaceAdapter<GroupEntity> = {
      ...base,
      version: 2,
      migrations: [
        {
          from: 1,
          migrate: (path, text) => {
            const { description, ...rest } = parseYaml(text) as Record<string, unknown>
            return [{ path, content: canonicalYaml({ ...rest, summary: description, version: 2 }) }]
          },
        },
      ],
      fromFiles(files) {
        const asV1 = new Map(
          [...files].map(([p, t]) => {
            const { summary, ...rest } = parseYaml(t) as Record<string, unknown>
            return [p, canonicalYaml({ ...rest, description: summary, version: 1 })] as const
          }),
        )
        return base.fromFiles(asV1)
      },
    }
    const fw = new IndexFramework(engine, watermarks, () => undefined)
    fw.register(v2)
    const head = await engine.head()
    await fw.rebuildIndex('groups')
    expect(git(engine.dir, 'rev-list', '--count', `${head}..HEAD`)).toBe('1')
    expect(git(engine.dir, 'log', '-1', '--format=%an|%s')).toBe(
      `eigenEnterprise|groups: migrate ${GROUP_FORMAT} v1→v2`,
    )
    expect(parseYaml(read(engine.dir, 'groups/sales.yaml'))).toMatchObject({
      version: 2,
      summary: 'old field',
    })
    expect((await index.all()).find((g) => g.name === 'Sales')?.description).toBe('old field')

    // the v1 code now meets v2 files: refuses, names the fix, changes nothing
    const fw1 = new IndexFramework(engine, watermarks, () => undefined)
    fw1.register(groupsAdapter(index))
    const before = await engine.head()
    await expect(fw1.rebuildIndex('groups')).rejects.toThrow(
      /v2 is newer than this server understands \(v1\)/,
    )
    expect(await engine.head()).toBe(before)
    // unknown format family refused too
    writeFileSync(
      join(engine.dir, 'groups/x.yaml'),
      canonicalYaml({ format: 'eigen.other', version: 1 }),
    )
    git(engine.dir, 'add', '.')
    git(engine.dir, 'commit', '-q', '-m', 'x')
    await expect(fw.rebuildIndex('groups')).rejects.toThrow(/unknown format "eigen.other"/)
  })

  it('one-time export: DB rows → files in one commit; refuses a second export', async () => {
    const engine = new GitEngine({ dir: tempDir('export') })
    await engine.open()
    const index = memoryGroupIndex(MEMBERS)
    const fw = new IndexFramework(engine, memoryWatermarks(), () => undefined)
    const adapter = groupsAdapter(index)
    fw.register(adapter)
    const legacy: GroupEntity[] = [
      {
        id: 'g1',
        name: 'Sales',
        description: '',
        createdBy: 'u-owner',
        createdAt: new Date('2026-10-01T00:00:00Z'),
        memberIds: ['u-ana'],
      },
      {
        id: 'g2',
        name: 'Dev',
        description: 'd',
        createdBy: 'u-owner',
        createdAt: new Date('2026-10-02T00:00:00Z'),
        memberIds: [],
      },
    ]
    const [r] = await exportDbToRepo(fw, [{ adapter, loadAll: async () => legacy }], {
      name: 'eigenEnterprise',
      email: 'os@eigen.local',
    })
    expect(r).toMatchObject({ surface: 'groups', entities: 2, files: 2 })
    expect(git(engine.dir, 'ls-tree', '--name-only', 'HEAD', 'groups/').split('\n')).toEqual([
      'groups/dev.yaml',
      'groups/sales.yaml',
    ])
    await fw.rebuildIndex('groups')
    expect(await index.all()).toEqual(
      expect.arrayContaining(legacy.map((g) => expect.objectContaining(g))),
    )
    await expect(
      exportDbToRepo(fw, [{ adapter, loadAll: async () => legacy }], { name: 'x', email: 'x@x' }),
    ).rejects.toThrow(/refused/)
  })
})
