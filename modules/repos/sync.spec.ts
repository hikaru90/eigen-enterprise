import { describe, expect, it } from 'vitest'
import { REPOS_DRIVE_SOURCE as SRC } from './manifest'
import { BUDGET_FLOOR } from './snapshot'
import { SYNC_EVERY_MS } from './sync'
import { TOKEN, setup } from './test-setup'
import { commit, pull, tokenError } from './testing'

const MIN = 60_000

describe('repos poller: one sync', () => {
  it('writes GitHub / <owner> / <repo> with the generated pages and the Markdown docs', async () => {
    const t = setup()
    await t.connect()
    expect(await t.service.tick()).toEqual({ claimed: 1, synced: 1, paused: 0, failed: 0 })
    expect(t.drive.roots.get(SRC)?.name).toBe('GitHub')
    expect(t.drive.keys(SRC)).toEqual([
      'owner:kindred',
      'repo:4242',
      'repo:4242/Activity.md',
      'repo:4242/Branches.md',
      'repo:4242/Docs',
      'repo:4242/Docs/README.md',
      'repo:4242/Docs/docs',
      'repo:4242/Docs/docs/guide',
      'repo:4242/Docs/docs/guide/intro.mdx',
      'repo:4242/Overview.md',
      'repo:4242/Pull requests.md',
    ])
    expect(t.drive.file(SRC, 'repo:4242')?.name).toBe('shop')
    expect(t.drive.file(SRC, 'repo:4242/Docs/README.md')?.content).toBe('# Shop\n\nHello.\n')
    expect(t.drive.file(SRC, 'repo:4242/Overview.md')?.content).toContain('`docs/huge.md` — 300 KB, over 256 KB')
    const [row] = await t.store.sources()
    expect(row!.lastSyncedAt).toEqual(t.clock.now)
    expect(row!.dueAt.getTime()).toBe(t.clock.now.getTime() + SYNC_EVERY_MS)
    expect(row!.claimedBy).toBeNull()
    expect(row!.docShas).toEqual({ 'README.md': 'r1', 'docs/guide/intro.mdx': 'g1' })
  })

  it('is due every 15 minutes, and an unchanged repo costs only conditional requests and writes nothing', async () => {
    const t = setup()
    await t.connect()
    await t.service.tick()
    t.advance(5 * MIN)
    expect((await t.service.tick()).claimed).toBe(0)
    t.advance(11 * MIN)
    const writes = t.drive.writes
    t.gh.calls = []
    expect((await t.service.tick()).synced).toBe(1)
    expect(t.gh.calls).toEqual(['repo kindred/shop', 'branches kindred/shop', 'pulls kindred/shop', 'openPulls kindred/shop'])
    expect(t.drive.writes).toBe(writes)
  })

  it('fetches commits only for a branch whose head moved, and only the blobs whose sha changed', async () => {
    const t = setup()
    await t.connect()
    await t.service.tick()
    t.data.branches[1] = { name: 'feature/cart', headSha: 'b3'.padEnd(40, '0') }
    t.data.commits['feature/cart']!.unshift(commit('b3', 'Cart coupons', '2026-11-12T14:10:00Z', 'grace'))
    t.data.branches[0] = { name: 'main', headSha: 'a2'.padEnd(40, '0') }
    t.data.commits.main!.unshift(commit('a2', 'Docs tweak', '2026-11-12T14:12:00Z'))
    t.data.tree!.entries[0] = { path: 'README.md', sha: 'r2', size: 22 }
    t.data.blobs!.r2 = '# Shop\n\nHello again.\n'
    t.advance(16 * MIN)
    t.gh.calls = []
    await t.service.tick()
    expect(t.gh.calls.filter((c) => c.startsWith('commits'))).toHaveLength(2)
    expect(t.gh.calls.filter((c) => c.startsWith('blob'))).toEqual(['blob kindred/shop'])
    expect(t.drive.file(SRC, 'repo:4242/Docs/README.md')?.content).toBe('# Shop\n\nHello again.\n')
    expect(t.drive.file(SRC, 'repo:4242/Docs/docs/guide/intro.mdx')?.content).toBe('# Intro\n')
    expect(t.drive.file(SRC, 'repo:4242/Activity.md')?.content).toContain('Cart coupons')
  })

  it('removes Drive items the repo no longer has (a deleted doc and its empty folders)', async () => {
    const t = setup()
    await t.connect()
    await t.service.tick()
    t.data.tree!.entries = t.data.tree!.entries.filter((e) => e.path !== 'docs/guide/intro.mdx')
    t.data.branches[0] = { name: 'main', headSha: 'a9'.padEnd(40, '0') }
    t.data.commits.main!.unshift(commit('a9', 'Drop the guide', '2026-11-12T14:20:00Z'))
    t.advance(16 * MIN)
    await t.service.tick()
    expect(t.drive.keys(SRC).filter((k) => k.includes('/Docs'))).toEqual(['repo:4242/Docs', 'repo:4242/Docs/README.md'])
  })

  it('follows a rename and a move to another owner (keyed on the repo id) and drops the empty owner folder', async () => {
    const t = setup()
    await t.connect()
    await t.service.tick()
    const moved = { ...t.data.repo, fullName: 'kdl/storefront', owner: 'kdl', name: 'storefront' }
    t.gh.repos.delete('kindred/shop')
    t.gh.addRepo({ ...t.data, repo: moved }, [TOKEN])
    // GitHub answers the old name with the renamed repo (a redirect).
    t.gh.repos.set('kindred/shop', { ...t.data, repo: moved })
    t.gh.visible.set(TOKEN, ['kindred/shop', 'kdl/storefront'])
    t.advance(16 * MIN)
    await t.service.tick()
    expect(t.drive.file(SRC, 'repo:4242')).toMatchObject({ name: 'storefront', parentKey: 'owner:kdl' })
    expect(t.drive.file(SRC, 'owner:kindred')).toBeUndefined()
    expect((await t.store.sources())[0]!.fullName).toBe('kdl/storefront')
  })

  it('fetches a kept doc again when its Drive copy is missing', async () => {
    const t = setup()
    await t.connect()
    await t.service.tick()
    await t.drive.remove(SRC, 'repo:4242/Docs/README.md')
    t.data.pulls.push({ ...t.data.pulls[0]!, number: 8, title: 'More' })
    t.advance(16 * MIN)
    await t.service.tick()
    expect(t.drive.file(SRC, 'repo:4242/Docs/README.md')?.content).toBe('# Shop\n\nHello.\n')
  })
})

describe('repos poller: limits and errors', () => {
  it(`stops below ${BUDGET_FLOOR} remaining requests and pauses every repo on the token until the reset`, async () => {
    const t = setup()
    await t.connect()
    t.gh.budget = { ...t.gh.budget, remaining: BUDGET_FLOOR + 1 }
    expect((await t.service.tick()).paused).toBe(1)
    const [row] = await t.store.sources()
    expect(row!.pausedUntil).toEqual(t.gh.budget.resetAt)
    expect(row!.dueAt).toEqual(t.gh.budget.resetAt)
    expect(row!.lastSyncedAt).toBeNull()
    expect((await t.service.tick()).claimed).toBe(0)
    t.clock.now = new Date(t.gh.budget.resetAt.getTime() + 1000)
    t.gh.budget = { ...t.gh.budget, remaining: 5000 }
    expect((await t.service.tick()).synced).toBe(1)
    expect((await t.store.sources())[0]!.pausedUntil).toBeNull()
  })

  it("honours GitHub's retry-after (rate_limited with resumeAt)", async () => {
    const t = setup()
    await t.connect()
    const resumeAt = new Date('2026-11-12T14:03:00Z')
    t.gh.failures.push({ method: 'branches', error: tokenError('rate_limited', { status: 429, resumeAt }) })
    expect((await t.service.tick()).paused).toBe(1)
    expect((await t.store.sources())[0]!.pausedUntil).toEqual(resumeAt)
  })

  it('a 401 stops every repo on that token until it is replaced', async () => {
    const t = setup()
    const id = await t.connect()
    t.gh.failures.push({ method: 'repo', error: tokenError('unauthorized', { status: 401 }) })
    expect((await t.service.tick()).failed).toBe(1)
    const [tok] = await t.service.tokens()
    expect(tok!.lastError).toBe('The GitHub token for ada no longer works. Create a new one and paste it here.')
    expect(tok!.repos[0]!.lastError).toBe(tok!.lastError)
    t.advance(20 * MIN)
    expect((await t.service.tick()).claimed).toBe(0)
    await t.service.replaceToken(id, TOKEN)
    expect((await t.service.tick()).synced).toBe(1)
    expect((await t.service.tokens())[0]!.lastError).toBeNull()
  })

  it('a 403/404 stops only that repo, in plain words', async () => {
    const t = setup()
    await t.connect()
    t.gh.failures.push({ method: 'repo', fullName: 'kindred/shop', error: tokenError('no_access', { status: 404 }) })
    await t.service.tick()
    const [tok] = await t.service.tokens()
    expect(tok!.lastError).toBeNull()
    expect(tok!.repos[0]!.lastError).toBe('The token can no longer see kindred/shop.')
  })

  it('an expired token stops its repos with the expiry date, without calling GitHub', async () => {
    const t = setup()
    await t.connect()
    t.clock.now = new Date('2027-02-01T00:00:00Z')
    t.gh.calls = []
    await t.service.tick()
    expect(t.gh.calls).toEqual([])
    expect((await t.service.tokens())[0]!.repos[0]!.lastError).toBe(
      'The GitHub token for ada expired on 2027-01-31. Create a new one and paste it here.',
    )
  })

  it('never puts the token in a log line, a stored error or a page error', async () => {
    const t = setup()
    await t.connect()
    t.gh.failures.push({ method: 'pulls', error: tokenError('unavailable', { status: 502 }) })
    await t.service.tick()
    t.advance(16 * MIN)
    t.gh.failures.push({ method: 'repo', error: tokenError('unauthorized', { status: 401 }) })
    await t.service.tick()
    const everything = JSON.stringify({ logs: t.logs, tokens: await t.service.tokens(), rows: [...t.store.tokenRows.values()] })
    expect(t.logs.length).toBeGreaterThan(0)
    expect(everything).not.toContain(TOKEN)
    expect(everything).not.toContain('secretSECRET')
  })
})

describe("repos poller: the assistant's summary and repos.synced", () => {
  const overview = (t: ReturnType<typeof setup>) => t.drive.file(SRC, 'repo:4242/Overview.md')!.content!
  const pushCommit = (t: ReturnType<typeof setup>, sha: string, subject: string) => {
    t.data.branches[1] = { name: 'feature/cart', headSha: sha.padEnd(40, '0') }
    t.data.commits['feature/cart']!.unshift(commit(sha, subject, t.clock.now.toISOString(), 'grace'))
  }

  it('the first sync writes a summary (no event: nothing happened yet, the repo was connected)', async () => {
    const t = setup()
    await t.connect()
    await t.service.tick()
    expect(t.summaries.calls).toHaveLength(1)
    expect(t.summaries.calls[0]!.delta.first).toBe(true)
    expect(t.summaries.calls[0]!.previous).toBeNull()
    expect(overview(t)).toContain('_Written by the assistant · 2026-11-12 14:00 UTC_')
    expect(overview(t)).toContain('Cart work is nearly done. Checkout shipped.')
    expect(overview(t)).toContain('- Cart totals is a draft (#7)')
    const [row] = await t.store.sources()
    expect(row!.summary).toMatchObject({ summary: 'Cart work is nearly done. Checkout shipped.', writtenAt: '2026-11-12T14:00:00.000Z' })
    expect(t.events).toEqual([])
  })

  it('an unchanged sync makes no call and emits nothing; a change does both, with the previous summary', async () => {
    const t = setup()
    await t.connect()
    await t.service.tick()
    t.advance(16 * MIN)
    await t.service.tick()
    expect(t.summaries.calls).toHaveLength(1)
    expect(t.events).toEqual([])
    expect(overview(t)).toContain('Cart work is nearly done.')

    t.advance(16 * MIN)
    pushCommit(t, 'b9', 'Cart coupons')
    t.data.pulls.push(pull({ number: 8, title: 'Coupons', createdAt: t.clock.now, updatedAt: t.clock.now }))
    t.data.pulls[0] = { ...t.data.pulls[0]!, state: 'closed', merged: true, closedAt: t.clock.now, mergedAt: t.clock.now, updatedAt: t.clock.now }
    t.summaries.next = { status: 'written', summary: 'Cart totals landed. Coupons are next.', highlights: [] }
    await t.service.tick()
    expect(t.summaries.calls).toHaveLength(2)
    expect(t.summaries.calls[1]!.previous?.summary).toBe('Cart work is nearly done. Checkout shipped.')
    expect(t.summaries.calls[1]!.delta.newCommits.map((c) => c.subject)).toEqual(['Cart coupons'])
    expect(t.events).toEqual([{ repoId: 4242, fullName: 'kindred/shop', newCommits: 1, prsOpened: 1, prsMerged: 1, prsClosed: 0 }])
    expect(overview(t)).toContain('Cart totals landed. Coupons are next.')
    expect(overview(t)).toContain('_Written by the assistant · 2026-11-12 14:32 UTC_')
  })

  it('no model selected: no summary, Overview says why, the pages still sync', async () => {
    const t = setup()
    t.summaries.next = { status: 'no_model', message: 'No model is selected for summaries. The owner selects one under Settings → AI provider.' }
    await t.connect()
    expect((await t.service.tick()).synced).toBe(1)
    expect(overview(t)).toContain('_No summary. No model is selected for summaries.')
    expect(t.drive.file(SRC, 'repo:4242/Pull requests.md')?.content).toContain('Cart totals')
    const [view] = await t.service.list()
    expect(view!.summary).toEqual({
      writtenAt: null,
      stale: false,
      problem: { kind: 'no_model', message: expect.stringContaining('No model is selected'), at: t.clock.now },
    })
    expect(view!.lastError).toBeNull()
  })

  it('a failed call is logged, shown and keeps the previous summary marked stale; the sync still succeeds', async () => {
    const t = setup()
    await t.connect()
    await t.service.tick()
    t.advance(16 * MIN)
    pushCommit(t, 'b9', 'Cart coupons')
    t.summaries.next = Object.assign(new Error('provider body with details'), { name: 'LlmHttpError' })
    expect((await t.service.tick()).synced).toBe(1)
    const text = overview(t)
    expect(text).toContain('Cart work is nearly done. Checkout shipped.')
    expect(text).toContain('_Out of date: updating it failed at 2026-11-12 14:16 UTC. Writing the summary failed.')
    expect(t.drive.file(SRC, 'repo:4242/Activity.md')?.content).toContain('Cart coupons')
    expect(t.logs.find(([m]) => m === '[repos] summary failed')?.[1]).toMatchObject({ repoId: 4242 })
    const [view] = await t.service.list()
    expect(view!.lastError).toBeNull()
    expect(view!.summary).toMatchObject({
      writtenAt: new Date('2026-11-12T14:00:00.000Z'),
      stale: true,
      problem: { kind: 'failed', message: 'Writing the summary failed.' },
    })
    expect(t.events).toHaveLength(1)

    t.advance(16 * MIN)
    pushCommit(t, 'ba', 'More coupons')
    t.summaries.next = { status: 'written', summary: 'Coupons are in.', highlights: [] }
    await t.service.tick()
    expect((await t.service.list())[0]!.summary).toMatchObject({ stale: false, problem: null })
    expect(overview(t)).not.toContain('Out of date')
  })

  it('a failing event sink is logged and never fails the sync', async () => {
    const t = setup()
    t.deps.emitSynced = async () => {
      throw new Error('sink down')
    }
    await t.connect()
    await t.service.tick()
    t.advance(16 * MIN)
    pushCommit(t, 'b9', 'Cart coupons')
    expect((await t.service.tick()).synced).toBe(1)
    expect(t.logs.some(([m]) => m === '[repos] repos.synced event failed')).toBe(true)
  })
})
