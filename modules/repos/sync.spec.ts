import { describe, expect, it } from 'vitest'
import { REPOS_DRIVE_SOURCE as SRC } from './manifest'
import { BUDGET_FLOOR } from './snapshot'
import { SYNC_EVERY_MS } from './sync'
import { TOKEN, setup } from './test-setup'
import { commit, pull, removeFile, setFile, tokenError } from './testing'

const MIN = 60_000
const T = 'repo:4242/tree'

/** Moves the default head (the tree is only re-read when it moved). */
const push = (t: ReturnType<typeof setup>, sha: string, subject: string) => {
  t.data.branches[0] = { name: t.data.repo.defaultBranch, headSha: sha.padEnd(40, '0') }
  t.data.commits[t.data.repo.defaultBranch]!.unshift(commit(sha, subject, t.clock.now.toISOString()))
  t.data.repo = { ...t.data.repo, pushedAt: t.clock.now }
}

describe('repos poller: one sync', () => {
  it('first sync: the tarball path — every file lands at its path under main/, Overview lists what was skipped and why', async () => {
    const t = setup()
    await t.connect()
    expect(await t.service.tick()).toEqual({ claimed: 1, synced: 1, paused: 0, failed: 0 })
    expect(t.drive.roots.get(SRC)?.name).toBe('GitHub')
    expect(t.drive.keys(SRC)).toEqual([
      'owner:kindred',
      'repo:4242',
      'repo:4242/Activity.md',
      'repo:4242/Branches.md',
      'repo:4242/Overview.md',
      'repo:4242/Pull requests.md',
      T,
      `${T}/README.md`,
      `${T}/assets`,
      `${T}/assets/logo.png`,
      `${T}/docs`,
      `${T}/docs/guide`,
      `${T}/docs/guide/intro.mdx`,
      `${T}/docs/huge.md`,
      `${T}/package.json`,
      `${T}/src`,
      `${T}/src/index.ts`,
      `${T}/src/util`,
      `${T}/src/util/format.ts`,
    ])
    expect(t.drive.file(SRC, 'repo:4242')?.name).toBe('shop')
    expect(t.drive.file(SRC, T)?.name).toBe('main')
    // Text and bytes both ride through the tarball; code opens as text, the PNG does not.
    expect(new TextDecoder().decode(t.drive.file(SRC, `${T}/README.md`)!.bytes!)).toBe('# Shop\n\nHello.\n')
    expect(t.drive.file(SRC, `${T}/README.md`)!.mime).toBe('text/plain; charset=utf-8')
    expect(t.drive.file(SRC, `${T}/src/index.ts`)!.mime).toBe('text/plain; charset=utf-8')
    expect(t.drive.file(SRC, `${T}/assets/logo.png`)!.mime).toBe('application/octet-stream')
    expect([...t.drive.file(SRC, `${T}/assets/logo.png`)!.bytes!]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82,
    ])
    // One tarball request, no per-blob fetches.
    expect(t.gh.calls).toContain('tarball kindred/shop')
    expect(t.gh.calls.filter((c) => c.startsWith('blob'))).toEqual([])
    // Overview: what was copied and what was not, with the reason.
    const overview = t.drive.file(SRC, 'repo:4242/Overview.md')!.content!
    expect(overview).toMatch(/7 files, [\d.]+ (KB|MB) from `main` @ `a100000`, in the main folder\./)
    expect(overview).toContain('- `assets/video.mp4` — ')
    expect(overview).toContain('a Git LFS pointer')
    expect(overview).toContain('- `docs/top.md` — ')
    expect(overview).toContain('a symlink')
    expect(overview).toContain('`docs/weird\\name.md`')
    expect(overview).toContain("a path Drive can't hold")
    expect(overview).toContain('- `media/iso.bin` — 21.0 MB, over 20 MB')
    expect(overview).toContain('- `vendor/lib` → `5ub5h45` — submodule')
    // The stored state: file rows for every copied path, none for the skipped.
    const [row] = await t.store.sources()
    expect(row!.lastSyncedAt).toEqual(t.clock.now)
    expect(row!.dueAt.getTime()).toBe(t.clock.now.getTime() + SYNC_EVERY_MS)
    expect(row!.claimedBy).toBeNull()
    expect((await t.store.sourceFiles(row!.id)).map((f) => f.path).sort()).toEqual(
      ['README.md', 'assets/logo.png', 'docs/guide/intro.mdx', 'docs/huge.md', 'package.json', 'src/index.ts', 'src/util/format.ts'].sort(),
    )
  })

  it('is due every 15 minutes; an unchanged repo costs only conditional requests and makes zero tree writes', async () => {
    const t = setup()
    await t.connect()
    await t.service.tick()
    t.advance(5 * MIN)
    expect((await t.service.tick()).claimed).toBe(0)
    t.advance(11 * MIN)
    const writes = t.drive.writes
    t.gh.calls = []
    t.drive.calls.length = 0
    expect((await t.service.tick()).synced).toBe(1)
    expect(t.gh.calls).toEqual(['repo kindred/shop', 'branches kindred/shop', 'pulls kindred/shop', 'openPulls kindred/shop'])
    expect(t.drive.writes).toBe(writes)
    expect(t.drive.writesUnder(T)).toEqual([])
  })

  it('one file changed: a single blob fetch, no tarball, only that file rewritten', async () => {
    const t = setup()
    await t.connect()
    await t.service.tick()
    const before = new Map([...t.drive.items].map(([k, v]) => [k, { ...v }]))
    setFile(t.data, 'src/index.ts', 'export const shop = 2\n')
    push(t, 'a2', 'Bump shop')
    t.advance(16 * MIN)
    t.gh.calls = []
    t.drive.calls.length = 0
    await t.service.tick()
    expect(t.gh.calls.filter((c) => c.startsWith('blob'))).toEqual(['blob kindred/shop'])
    expect(t.gh.calls.filter((c) => c.startsWith('tarball'))).toEqual([])
    expect(t.drive.writesUnder(T).map((c) => c.op)).toEqual(['upsertBytes', 'upsertMany'])
    expect(new TextDecoder().decode(t.drive.file(SRC, `${T}/src/index.ts`)!.bytes!)).toBe('export const shop = 2\n')
    // Only that file was touched in the tree; every other tree file kept its id and bytes
    // (the generated pages legitimately change with every commit).
    for (const [k, v] of t.drive.items) {
      const was = before.get(k)
      if (!was || was.kind !== 'file' || !v.key.startsWith(`${T}/`)) continue
      if (v.key === `${T}/src/index.ts`) continue
      expect(v.contentSha).toBe(was.contentSha)
      expect(v.itemId).toBe(was.itemId)
    }
    const [row] = await t.store.sources()
    const files = new Map((await t.store.sourceFiles(row!.id)).map((f) => [f.path, f.sha]))
    expect(files.size).toBe(7)
    expect(files.get('src/index.ts')).toBe(t.data.tree!.entries.find((e) => e.path === 'src/index.ts')!.sha)
    expect(t.drive.file(SRC, `${T}/README.md`)!.contentSha).toBe(before.get(`${SRC}\0${T}/README.md`)!.contentSha)
  })

  it('60 files changed: the tarball, not 61 blob fetches', async () => {
    const t = setup()
    await t.connect()
    await t.service.tick()
    for (let i = 0; i < 60; i++) setFile(t.data, `src/gen/g${String(i).padStart(2, '0')}.ts`, `export const g${i} = ${i}\n`)
    push(t, 'a3', 'Generated files')
    t.advance(16 * MIN)
    t.gh.calls = []
    await t.service.tick()
    expect(t.gh.calls.filter((c) => c.startsWith('blob'))).toEqual([])
    expect(t.gh.calls.filter((c) => c.startsWith('tarball'))).toEqual(['tarball kindred/shop'])
    expect(t.drive.file(SRC, `${T}/src/gen/g59.ts`)!.mime).toBe('text/plain; charset=utf-8')
    const [row] = await t.store.sources()
    expect((await t.store.sourceFiles(row!.id)).length).toBe(67)
  })

  it('a deleted file is removed, with its emptied folders', async () => {
    const t = setup()
    await t.connect()
    await t.service.tick()
    removeFile(t.data, 'src/util/format.ts')
    push(t, 'a4', 'Drop the formatter')
    t.advance(16 * MIN)
    await t.service.tick()
    expect(t.drive.keys(SRC).filter((k) => k.includes('src/util'))).toEqual([])
    expect(new TextDecoder().decode(t.drive.file(SRC, `${T}/src/index.ts`)!.bytes!)).toBe('export const shop = 1\n')
    const [row] = await t.store.sources()
    expect((await t.store.sourceFiles(row!.id)).map((f) => f.path)).not.toContain('src/util/format.ts')
  })

  it('a renamed default branch renames the tree folder; the keys stay', async () => {
    const t = setup()
    await t.connect()
    await t.service.tick()
    const keysBefore = t.drive.keys(SRC)
    t.data.repo = { ...t.data.repo, defaultBranch: 'master' }
    t.data.branches[0] = { name: 'master', headSha: 'a1'.padEnd(40, '0') }
    t.data.commits.master = t.data.commits.main
    t.advance(16 * MIN)
    await t.service.tick()
    expect(t.drive.file(SRC, T)?.name).toBe('master')
    expect(t.drive.keys(SRC)).toEqual(keysBefore)
    const overview = t.drive.file(SRC, 'repo:4242/Overview.md')!.content!
    expect(overview).toContain('from `master` @ `a100000`, in the master folder')
  })

  it('fetches a missing tree file again when the head did not move (Drive lost a copy)', async () => {
    const t = setup()
    await t.connect()
    await t.service.tick()
    await t.drive.remove(SRC, `${T}/README.md`)
    t.advance(16 * MIN)
    t.gh.calls = []
    await t.service.tick()
    expect(t.gh.calls.filter((c) => c.startsWith('blob'))).toEqual(['blob kindred/shop'])
    expect(new TextDecoder().decode(t.drive.file(SRC, `${T}/README.md`)!.bytes!)).toBe('# Shop\n\nHello.\n')
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
    expect(new TextDecoder().decode(t.drive.file(SRC, `${T}/README.md`)!.bytes!)).toBe('# Shop\n\nHello.\n')
    expect((await t.store.sources())[0]!.fullName).toBe('kdl/storefront')
  })

  it('upgrade: a source from before the full mirror (doc_shas, a Docs/ folder) ends with no Docs/ and the whole tree under main/', async () => {
    const t = setup()
    await t.connect()
    const [row] = await t.store.sources()
    // The pre-0161 snapshot shape: docs, no tree; the doc_shas column is gone, the file table empty.
    await t.store.updateSource(row!.id, {
      branchHeads: { main: 'a1'.padEnd(40, '0') },
      snapshot: {
        takenAt: '2026-11-01T00:00:00.000Z',
        repo: { id: 4242, fullName: 'kindred/shop', owner: 'kindred', name: 'shop', description: null, htmlUrl: 'https://github.com/kindred/shop', defaultBranch: 'main', pushedAt: null, archived: false, private: true },
        branches: [],
        pulls: [],
        docs: { commitSha: 'a1'.padEnd(40, '0'), copied: [{ path: 'README.md', sha: 'old-sha', size: 20 }], notCopied: [], truncated: false },
      } as never,
    })
    await t.drive.ensureRoot(SRC, 'GitHub')
    await t.drive.upsertFolder(SRC, 'owner:kindred', null, 'kindred')
    await t.drive.upsertFolder(SRC, 'repo:4242', 'owner:kindred', 'shop')
    await t.drive.upsertFolder(SRC, 'repo:4242/Docs', 'repo:4242', 'Docs')
    await t.drive.upsertText(SRC, 'repo:4242/Docs/README.md', 'repo:4242/Docs', 'README.md', '# Shop (old copy)\n')
    await t.service.tick()
    const keys = t.drive.keys(SRC)
    expect(keys.some((k) => k.includes('/Docs'))).toBe(false)
    expect(keys).toContain(`${T}/src/index.ts`)
    expect(new TextDecoder().decode(t.drive.file(SRC, `${T}/README.md`)!.bytes!)).toBe('# Shop\n\nHello.\n')
    expect(t.drive.file(SRC, 'repo:4242/Overview.md')!.content).toMatch(/7 files, /)
  })

  it('a truncated tree: the tarball’s own listing is the file list, and Overview carries no cut-short note', async () => {
    const t = setup()
    await t.connect()
    t.data.tree!.truncated = true
    await t.service.tick()
    expect(t.drive.keys(SRC)).toContain(`${T}/src/index.ts`)
    expect(t.drive.keys(SRC)).toContain(`${T}/docs/huge.md`)
    expect(t.gh.calls.filter((c) => c.startsWith('blob'))).toEqual([])
    const overview = t.drive.file(SRC, 'repo:4242/Overview.md')!.content!
    expect(overview).not.toContain('cut the file list')
    const [row] = await t.store.sources()
    expect((row!.snapshot as { tree: { truncated: boolean } }).tree.truncated).toBe(true)
  })
})

describe('repos poller: the copy mode (per repo)', () => {
  it('"docs only" gives today’s file set at the new paths; switching back adds the code again', async () => {
    const t = setup()
    await t.connect()
    await t.service.tick()
    await t.service.setCopyMode(4242, 'docs')
    expect((await t.service.tick()).synced).toBe(1)
    expect(t.drive.keys(SRC).filter((k) => k.startsWith(`${T}/`))).toEqual([
      `${T}/README.md`,
      `${T}/docs`,
      `${T}/docs/guide`,
      `${T}/docs/guide/intro.mdx`,
      `${T}/docs/huge.md`,
    ])
    const overview = t.drive.file(SRC, 'repo:4242/Overview.md')!.content!
    expect(overview).toMatch(/3 Markdown files, [\d.]+ (KB|MB) from `main` @ `a100000`, in the main folder\./)
    const [row] = await t.store.sources()
    expect(row!.copyMode).toBe('docs')
    expect((await t.store.sourceFiles(row!.id)).map((f) => f.path).sort()).toEqual(['README.md', 'docs/guide/intro.mdx', 'docs/huge.md'].sort())

    await t.service.setCopyMode(4242, 'all')
    await t.service.tick()
    expect(t.drive.file(SRC, `${T}/src/index.ts`)!.mime).toBe('text/plain; charset=utf-8')
    expect((await t.store.sourceFiles(row!.id)).length).toBe(7)
  })
})

describe('repos poller: integrity and rate limits', () => {
  it('a tarball file that does not match its git blob sha fails the sync loudly and writes nothing new', async () => {
    const t = setup()
    // Corrupt the blob behind README.md before the first sync, keeping the tree
    // entry (and so the size the fake tarball checks) intact: the archive then
    // serves bytes whose git blob sha is not the sha the tree lists.
    const entry = t.data.tree!.entries.find((e) => e.path === 'README.md')!
    t.data.blobs![entry.sha] = new TextEncoder().encode('z'.repeat(entry.size ?? 0))
    await t.connect()
    expect((await t.service.tick()).failed).toBe(1)
    expect(t.drive.keys(SRC)).toEqual(['owner:kindred', 'repo:4242'])
    expect(t.drive.writesUnder(T)).toEqual([])
    const [row] = await t.store.sources()
    expect(row!.lastError).toBeTruthy()
    expect(await t.store.sourceFiles(row!.id)).toEqual([])
    expect(t.logs.some(([m, f]) => m === '[repos] sync failed' && String((f as { error?: string }).error).includes('sha mismatch'))).toBe(true)
  })

  it('a rate pause on the tarball request writes nothing: no tree items, no file rows, no snapshot', async () => {
    const t = setup()
    await t.connect()
    const resumeAt = new Date('2026-11-12T14:10:00Z')
    t.gh.failures.push({ method: 'tarball', fullName: 'kindred/shop', error: tokenError('rate_limited', { status: 429, resumeAt }) })
    expect((await t.service.tick()).paused).toBe(1)
    expect(t.drive.writesUnder(T)).toEqual([])
    expect(t.drive.keys(SRC)).toEqual(['owner:kindred', 'repo:4242'])
    const [row] = await t.store.sources()
    expect(await t.store.sourceFiles(row!.id)).toEqual([])
    expect(row!.snapshot).toBeNull()
    expect(row!.pausedUntil).toEqual(resumeAt)
  })

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

  it('a missing permission names it and says how to add it (a private repo without Pull requests: read)', async () => {
    const t = setup()
    await t.connect()
    t.gh.failures.push({
      method: 'pulls',
      fullName: 'kindred/shop',
      error: tokenError('missing_permission', { status: 403, permission: 'pull_requests' }),
    })
    await t.service.tick()
    const [tok] = await t.service.tokens()
    expect(tok!.lastError).toBeNull()
    expect(tok!.repos[0]!.lastError).toBe(
      'The token can see kindred/shop but is missing “Pull requests: Read-only”. On GitHub, edit the token and add it (it stays the same token), then Sync now.',
    )
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
  const pushFeature = (t: ReturnType<typeof setup>, sha: string, subject: string) => {
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
    pushFeature(t, 'b9', 'Cart coupons')
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
    pushFeature(t, 'b9', 'Cart coupons')
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
    pushFeature(t, 'ba', 'More coupons')
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
    pushFeature(t, 'b9', 'Cart coupons')
    expect((await t.service.tick()).synced).toBe(1)
    expect(t.logs.some(([m]) => m === '[repos] repos.synced event failed')).toBe(true)
  })
})
