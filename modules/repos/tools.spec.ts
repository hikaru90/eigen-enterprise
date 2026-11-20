import { describe, expect, it } from 'vitest'
import { reposManifest, REPOS_TOOL_NAMES } from './manifest'
import { TOKEN, setup } from './test-setup'
import { createReposTools } from './tools'

const agent = { principal: { id: 'agent:1', kind: 'agent' as const, roles: ['agent'] }, requestId: 'r' }

describe('repos.* tools', () => {
  it('match the manifest, with read/mutate classes, approval risk and the activity sentence', () => {
    const tools = createReposTools({ service: async () => setup().service })
    expect(tools.map((t) => t.name)).toEqual([...REPOS_TOOL_NAMES])
    expect(reposManifest.tools).toEqual(tools.map((t) => t.name))
    const [list, sync, copyMode] = tools
    expect(list).toMatchObject({ module: 'repos', auditClass: 'read' })
    expect(sync).toMatchObject({ module: 'repos', auditClass: 'mutate', approvalRisk: 'internal' })
    expect(copyMode).toMatchObject({ module: 'repos', auditClass: 'mutate', approvalRisk: 'internal', permission: { roles: ['owner', 'admin'] } })
    expect(sync!.activity!({ repo: 'kindred/shop' }, { repo: 'kindred/shop', status: 'synced' })).toBe('Synced kindred/shop from GitHub')
    expect(sync!.activity!({ repo: 'kindred/shop' }, undefined)).toBe('Synced kindred/shop from GitHub')
    expect(copyMode!.activity!({ repoId: 4242, mode: 'docs' }, { repo: 'kindred/shop' })).toBe('Set kindred/shop to copy the Markdown docs only')
    expect(copyMode!.activity!({ repoId: 4242, mode: 'all' }, undefined)).toBe('Set repo 4242 to copy all files')
  })

  it('repos.list shows status and Drive folder ids; repos.sync_now syncs; neither shows the token', async () => {
    const t = setup()
    await t.connect()
    const [list, sync] = createReposTools({ service: async () => t.service })
    expect(await sync!.handler(agent, { repo: '4242' })).toEqual({ repo: 'kindred/shop', status: 'synced', changed: true })
    const out = (await list!.handler(agent, {})) as { repos: Array<Record<string, unknown>> }
    expect(out.repos).toEqual([
      expect.objectContaining({ repo: 'kindred/shop', repoId: 4242, copyMode: 'all', lastError: null, driveFolderId: expect.any(String), lastSyncedAt: '2026-11-12T14:00:00.000Z' }),
    ])
    expect(JSON.stringify(out)).not.toContain(TOKEN)
    await expect(sync!.handler(agent, { repo: 'kindred/shop', token: 'x' })).rejects.toThrow()
  })

  it('repos.set_copy_mode sets the mode and makes the repo due now; the next sync applies it', async () => {
    const t = setup()
    await t.connect()
    await t.service.tick()
    const [, , copyMode] = createReposTools({ service: async () => t.service })
    expect(await copyMode!.handler(agent, { repoId: 4242, mode: 'docs' })).toEqual({ repo: 'kindred/shop', repoId: 4242, copyMode: 'docs' })
    const [row] = await t.store.sources()
    expect(row!.copyMode).toBe('docs')
    expect(row!.dueAt).toEqual(t.clock.now)
    await expect(copyMode!.handler(agent, { repoId: 999, mode: 'docs' })).rejects.toThrow('That repo is not connected.')
    await expect(copyMode!.handler(agent, { repoId: 4242, mode: 'everything' } as never)).rejects.toThrow()
    // The next tick really applies the new file set (docs only).
    expect((await t.service.tick()).synced).toBe(1)
    expect(t.drive.keys('repos').some((k) => k.includes('src/index.ts'))).toBe(false)
  })
})
