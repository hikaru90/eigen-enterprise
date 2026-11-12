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
    const [list, sync] = tools
    expect(list).toMatchObject({ module: 'repos', auditClass: 'read' })
    expect(sync).toMatchObject({ module: 'repos', auditClass: 'mutate', approvalRisk: 'internal' })
    expect(sync!.activity!({ repo: 'kindred/shop' }, { repo: 'kindred/shop', status: 'synced' })).toBe('Synced kindred/shop from GitHub')
    expect(sync!.activity!({ repo: 'kindred/shop' }, undefined)).toBe('Synced kindred/shop from GitHub')
  })

  it('repos.list shows status and Drive folder ids; repos.sync_now syncs; neither shows the token', async () => {
    const t = setup()
    await t.connect()
    const [list, sync] = createReposTools({ service: async () => t.service })
    expect(await sync!.handler(agent, { repo: '4242' })).toEqual({ repo: 'kindred/shop', status: 'synced', changed: true })
    const out = (await list!.handler(agent, {})) as { repos: Array<Record<string, unknown>> }
    expect(out.repos).toEqual([
      expect.objectContaining({ repo: 'kindred/shop', repoId: 4242, lastError: null, driveFolderId: expect.any(String), lastSyncedAt: '2026-11-12T14:00:00.000Z' }),
    ])
    expect(JSON.stringify(out)).not.toContain(TOKEN)
    await expect(sync!.handler(agent, { repo: 'kindred/shop', token: 'x' })).rejects.toThrow()
  })
})
