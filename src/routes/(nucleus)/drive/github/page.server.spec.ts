import type { ReposService } from '../../../../../modules/repos/service'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CLASSIC_TOKEN_MESSAGE } from '../../../../../modules/repos/errors'
import { TOKEN, setup } from '../../../../../modules/repos/test-setup'

const { holder, adminMock } = vi.hoisted(() => ({
  holder: { service: null as unknown },
  adminMock: vi.fn(async (_id: string) => true),
}))
vi.mock('$lib/server/auth/user-role', () => ({ isUserAdmin: adminMock }))
vi.mock('$lib/server/boot', () => ({
  appKernel: async () => ({ activations: { get: async (id: string) => id === 'repos' } }),
}))
vi.mock('../../../../../modules/repos/live', () => ({
  reposService: () => holder.service as ReposService,
}))

const { load, actions } = await import('./+page.server')

const locals = { user: { id: 'user-1', email: 'me@x.co' } }
const post = (fields: Record<string, string>) => {
  const body = new FormData()
  for (const [k, v] of Object.entries(fields)) body.set(k, v)
  return {
    locals,
    request: new Request('http://x/drive/github', { method: 'POST', body }),
  } as never
}
type Act = keyof typeof actions
const run = async (name: Act, fields: Record<string, string>) =>
  (await actions[name]!(post(fields))) as Record<string, unknown>

describe('/drive/github (admin only)', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
    holder.service = t.service
    adminMock.mockResolvedValue(true)
  })

  it('refuses members who are not admins, and signed-out visitors', async () => {
    adminMock.mockResolvedValue(false)
    await expect(load({ locals } as never)).rejects.toMatchObject({ status: 403 })
    await expect(run('addToken', { token: TOKEN })).rejects.toMatchObject({ status: 403 })
    await expect(load({ locals: {} } as never)).rejects.toMatchObject({ status: 302 })
  })

  it('paste → live check → stored; the page shows …last4, owner and expiry, never the token', async () => {
    expect(await run('addToken', { token: TOKEN })).toEqual({
      action: 'addToken',
      ok: true,
      login: 'ada',
    })
    const page = (await load({ locals } as never)) as {
      active: boolean
      tokens: Array<Record<string, unknown>>
    }
    expect(page.active).toBe(true)
    expect(page.tokens).toEqual([
      expect.objectContaining({
        login: 'ada',
        last4: '9z9z',
        expiresAt: '2027-01-31T00:00:00.000Z',
        expiresSoon: false,
        visible: [
          { id: 4242, fullName: 'kindred/shop', private: true, archived: false, syncing: false },
        ],
        visibleError: null,
      }),
    ])
    expect(JSON.stringify(page)).not.toContain(TOKEN)
  })

  it('refuses a classic token with the plain reason (400, nothing echoed)', async () => {
    t.gh.identities.set('ghp_classic_one', { login: 'ada', expiresAt: null, classic: true })
    const out = await run('addToken', { token: 'ghp_classic_one' })
    expect(out).toMatchObject({
      status: 400,
      data: {
        action: 'addToken',
        error: CLASSIC_TOKEN_MESSAGE,
        agent: { attempted: 'Connecting a GitHub token (Drive › GitHub)' },
      },
    })
    expect(JSON.stringify(out)).not.toContain('ghp_classic_one')
  })

  it('tick, sync now, untick (folder deleted), remove token', async () => {
    await run('addToken', { token: TOKEN })
    const [tok] = await t.service.tokens()
    expect(
      await run('setRepo', { tokenId: tok!.id, repoId: '4242', syncing: 'true' }),
    ).toMatchObject({ ok: true, fullName: 'kindred/shop', syncing: true })
    const [src] = await t.store.sources()
    expect(await run('syncNow', { sourceId: src!.id })).toEqual({
      action: 'syncNow',
      ok: true,
      fullName: 'kindred/shop',
      status: 'synced',
    })
    expect(t.drive.keys('repos').length).toBeGreaterThan(0)
    const page = (await load({ locals } as never)) as {
      tokens: Array<{ repos: Array<Record<string, unknown>> }>
    }
    expect(page.tokens[0]!.repos).toEqual([
      expect.objectContaining({
        fullName: 'kindred/shop',
        lastError: null,
        lastSyncedAt: '2026-11-12T14:00:00.000Z',
      }),
    ])
    expect(
      await run('setRepo', { tokenId: tok!.id, repoId: '4242', syncing: 'false' }),
    ).toMatchObject({ ok: true, syncing: false })
    expect(t.drive.keys('repos')).toEqual([])
    await run('setRepo', { tokenId: tok!.id, repoId: '4242', syncing: 'true' })
    expect(await run('removeToken', { tokenId: tok!.id })).toEqual({
      action: 'removeToken',
      ok: true,
      removedRepos: 1,
    })
    expect(await t.service.tokens()).toEqual([])
    expect(
      await run('setRepo', { tokenId: tok!.id, repoId: 'abc', syncing: 'true' }),
    ).toMatchObject({ status: 400 })
  })

  it('shows each repo copy mode and branch; setCopyMode switches it (docs only, then all again) and makes it due now', async () => {
    await t.connect()
    await t.service.tick()
    type Page = { tokens: Array<{ repos: Array<Record<string, unknown>> }> }
    let page = (await load({ locals } as never)) as Page
    expect(page.tokens[0]!.repos[0]).toMatchObject({
      fullName: 'kindred/shop',
      copyMode: 'all',
      defaultBranch: 'main',
    })

    expect(await run('setCopyMode', { repoId: '4242', mode: 'docs' })).toEqual({
      action: 'setCopyMode',
      ok: true,
      fullName: 'kindred/shop',
      copyMode: 'docs',
    })
    const [src] = await t.store.sources()
    expect(src!.copyMode).toBe('docs')
    expect(src!.dueAt).toEqual(t.clock.now)
    page = (await load({ locals } as never)) as Page
    expect(page.tokens[0]!.repos[0]).toMatchObject({ copyMode: 'docs' })
    // The next sync applies it: only the Markdown stays.
    await run('syncNow', { sourceId: src!.id })
    expect(t.drive.keys('repos').some((k) => k.endsWith('src/index.ts'))).toBe(false)

    expect(await run('setCopyMode', { repoId: '4242', mode: 'all' })).toMatchObject({
      ok: true,
      copyMode: 'all',
    })
    await run('syncNow', { sourceId: src!.id })
    expect(t.drive.keys('repos').some((k) => k.endsWith('src/index.ts'))).toBe(true)
  })

  it('setCopyMode refuses a bad mode or repo with a plain error, and non-admins', async () => {
    await t.connect()
    expect(await run('setCopyMode', { repoId: '4242', mode: 'everything' })).toMatchObject({
      status: 400,
      data: {
        action: 'setCopyMode',
        error: 'Choose all files or docs only.',
        agent: { cause: 'mode "everything" is neither "all" nor "docs".' },
      },
    })
    expect(await run('setCopyMode', { repoId: 'abc', mode: 'docs' })).toMatchObject({
      status: 400,
      data: { action: 'setCopyMode', error: 'Pick a repo from the list.' },
    })
    expect(await run('setCopyMode', { repoId: '999', mode: 'docs' })).toMatchObject({
      status: 400,
      data: {
        action: 'setCopyMode',
        error: expect.stringContaining('That repo is not connected.'),
        agent: { tool: 'repos.set_copy_mode', input: { repoId: 999, mode: 'docs' } },
      },
    })
    adminMock.mockResolvedValue(false)
    await expect(run('setCopyMode', { repoId: '4242', mode: 'docs' })).rejects.toMatchObject({
      status: 403,
    })
  })

  it('shows how the summary went: written, or why it is missing (no model selected, a failure)', async () => {
    t.summaries.next = {
      status: 'no_model',
      message:
        'No model is selected for summaries. The owner selects one under Settings → AI provider.',
    }
    await t.connect()
    await t.service.tick()
    type Page = {
      summaryNoModel: boolean
      tokens: Array<{ repos: Array<{ summary: Record<string, unknown> }> }>
    }
    let page = (await load({ locals } as never)) as Page
    expect(page.summaryNoModel).toBe(true)
    expect(page.tokens[0]!.repos[0]!.summary).toEqual({
      writtenAt: null,
      stale: false,
      problem: {
        kind: 'no_model',
        message: expect.stringContaining('No model is selected for summaries'),
        at: '2026-11-12T14:00:00.000Z',
      },
    })
    const [src] = await t.store.sources()
    t.summaries.next = { status: 'written', summary: 'All good.', highlights: [] }
    await t.store.updateSource(src!.id, { snapshot: null })
    await run('syncNow', { sourceId: src!.id })
    page = (await load({ locals } as never)) as Page
    expect(page.summaryNoModel).toBe(false)
    expect(page.tokens[0]!.repos[0]!.summary).toEqual({
      writtenAt: '2026-11-12T14:00:00.000Z',
      stale: false,
      problem: null,
    })
  })
})
