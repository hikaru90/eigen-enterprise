import type { RepoSnapshot, TreeSnap } from './snapshot-types'
import { describe, expect, it } from 'vitest'
import { render } from './render'
import { FILE_LIMITS, pickFiles, takeSnapshot } from './snapshot'
import { FakeGitHub, pull, sampleRepo } from './testing'

const TOKEN = 'github_pat_render'

async function snapshotOf(mutate: (d: ReturnType<typeof sampleRepo>) => void = () => {}): Promise<RepoSnapshot> {
  const gh = new FakeGitHub()
  gh.identities.set(TOKEN, { login: 'ada', expiresAt: null, classic: false })
  const d = sampleRepo()
  mutate(d)
  gh.addRepo(d, [TOKEN])
  const r = await takeSnapshot(
    gh.client(TOKEN),
    { fullName: d.repo.fullName, etags: {}, branchHeads: {}, copyMode: 'all', storedFiles: [], snapshot: null },
    new Date('2026-11-12T14:00:00Z'),
  )
  // Finalise the tree from the plan the way the sync does (no bytes here): the
  // LFS pointer shows up as not copied only once its bytes were fetched. An
  // empty repo (no branches) already carries its empty tree.
  if (r.snapshot.tree) return { ...r.snapshot, tree: r.snapshot.tree }
  const tree = r.tree
  if (!tree) throw new Error('expected a tree plan or a tree snapshot')
  const lfs = tree.picked.filter((f) => f.path === 'assets/video.mp4')
  const snap: TreeSnap = {
    commitSha: tree.commitSha,
    mode: tree.mode,
    count: tree.picked.length - lfs.length,
    bytes: tree.picked.reduce((n, f) => n + f.size, 0),
    notCopied: [...tree.notCopied, ...lfs.map((f) => ({ path: f.path, size: f.size, reason: 'lfs' as const, sha: f.sha }))],
    truncated: tree.truncated,
  }
  return { ...r.snapshot, tree: snap }
}

const NONE = { summary: null, problem: null }
const SUMMARY = {
  summary: 'Cart work is nearly done.',
  highlights: [{ kind: 'pr' as const, text: 'Cart totals is in draft', ref: '#7' }],
  writtenAt: '2026-11-12T14:01:00Z',
}

const files = (s: RepoSnapshot, summary: Parameters<typeof render>[1] = NONE) =>
  Object.fromEntries(render(s, summary).flatMap((i) => (i.kind === 'file' ? [[i.key, i.content]] : [])))

describe('render (pure snapshot → the generated pages)', () => {
  it('renders the generated pages (snapshots)', async () => {
    const f = files(await snapshotOf())
    expect(f['repo:4242/Overview.md']).toMatchSnapshot('Overview.md')
    expect(f['repo:4242/Branches.md']).toMatchSnapshot('Branches.md')
    expect(f['repo:4242/Pull requests.md']).toMatchSnapshot('Pull requests.md')
    expect(f['repo:4242/Activity.md']).toMatchSnapshot('Activity.md')
  })

  it("puts the assistant's summary on top of Overview, labelled with its time", async () => {
    const f = files(await snapshotOf(), { summary: SUMMARY, problem: null })
    expect(f['repo:4242/Overview.md']).toMatchSnapshot('Overview.md with summary')
  })

  it('says why the summary is missing or out of date (no model selected, a failed update)', async () => {
    const s = await snapshotOf()
    const noModel = { kind: 'no_model' as const, message: 'No model is selected for summaries. The owner selects one under Settings → AI provider.', at: '2026-11-12T14:02:00Z' }
    const failed = { kind: 'failed' as const, message: 'The AI provider refused the request (HTTP 500).', at: '2026-11-12T14:02:00Z' }
    const whats = (state: Parameters<typeof render>[1]) => files(s, state)['repo:4242/Overview.md']!.split('## About')[0]
    expect(whats({ summary: null, problem: noModel })).toMatchSnapshot('missing: no model')
    expect(whats({ summary: null, problem: failed })).toMatchSnapshot('missing: failed')
    expect(whats({ summary: SUMMARY, problem: noModel })).toMatchSnapshot('stale: no model')
    const stale = whats({ summary: SUMMARY, problem: failed })
    expect(stale).toContain('_Out of date: updating it failed at 2026-11-12 14:02 UTC. The AI provider refused the request (HTTP 500).')
    expect(stale).toContain('Cart work is nearly done.')
  })

  it('lists every open pull request, also one nobody touched in the last 30 days', async () => {
    const s = await snapshotOf((d) => {
      d.pulls.push(pull({ number: 2, title: 'Wishlist', headRef: 'wishlist', createdAt: new Date('2026-06-01T09:00:00Z'), updatedAt: new Date('2026-08-01T09:00:00Z') }))
    })
    const f = files(s)
    const [open, done] = f['repo:4242/Pull requests.md']!.split('## Merged or closed')
    expect(open).toContain('## Open (2)')
    expect(open).toContain('[#2](https://github.com/kindred/shop/pull/2) Wishlist')
    expect(done).not.toContain('Wishlist')
    expect(f['repo:4242/Overview.md']).toContain('- Open pull requests: 2')
    expect(s.pulls.map((p) => p.number).sort()).toEqual([2, 5, 7])
  })

  it('is deterministic and the same bytes for the same snapshot', async () => {
    const s = await snapshotOf()
    expect(render(s, NONE)).toEqual(render(structuredClone(s), NONE))
  })

  it('renders an empty repo (no branches, no files) without inventing anything', async () => {
    const s = await snapshotOf((d) => {
      d.branches = []
      d.pulls = []
    })
    const f = files(s)
    expect(f['repo:4242/Overview.md']).toContain('No branch had a commit in the last 30 days.')
    expect(f['repo:4242/Activity.md']).toContain('No commits.')
    expect(f['repo:4242/Overview.md']).toContain('No files on `main`.')
    expect(render(s, NONE).some((i) => i.key.includes('/tree'))).toBe(false)
  })

  it('says "Markdown files" in docs mode, "files" otherwise, and caps the not-copied list at 200 lines', async () => {
    const s = await snapshotOf()
    const docs: RepoSnapshot = { ...s, tree: { ...s.tree, mode: 'docs', count: 3, bytes: 3 * 1024 } }
    expect(files(docs)['repo:4242/Overview.md']).toContain('3 Markdown files, 3 KB from `main` @ `a100000`, in the main folder.')
    expect(files(s)['repo:4242/Overview.md']).toMatch(/7 files, [\d.]+ (KB|MB) from `main` @ `a100000`, in the main folder\./)
    const noisy: RepoSnapshot = {
      ...s,
      tree: { ...s.tree, notCopied: Array.from({ length: 205 }, (_, i) => ({ path: `x/file-${i}.bin`, size: 10, reason: 'file_size' as const })) },
    }
    const overview = files(noisy)['repo:4242/Overview.md']!
    expect(overview.match(/^- `x\/file-\d+\.bin`/gm)).toHaveLength(200)
    expect(overview).toContain('- and 5 more')
  })

  it('keeps a quiet branch (no commit in 90 days) in its own table', async () => {
    const f = files(await snapshotOf())['repo:4242/Branches.md']!
    const [main, quiet] = f.split('## Quiet branches')
    expect(main).not.toContain('old/spike')
    expect(quiet).toContain('old/spike')
  })
})

describe('pickFiles (the full-mirror limits, plan §2.4/§2.5)', () => {
  const f = (path: string, size: number, over: { mode?: string; sha?: string } = {}) => ({ path, size, sha: over.sha ?? 's', mode: over.mode ?? '100644' })

  it('copies at most 50,000 files, 20 MB each, 2 GB per repo; shallow paths win', () => {
    const root = f('README.md', 10)
    const many = [root, ...Array.from({ length: FILE_LIMITS.files }, (_, i) => f(`deep/dir-${i}/file-${i}.ts`, 10))]
    const out = pickFiles(many, 'all')
    expect(out.copied).toHaveLength(FILE_LIMITS.files)
    expect(out.copied[0]!.path).toBe('README.md') // the root file always makes it
    expect(out.notCopied.every((n) => n.reason === 'file_count')).toBe(true)
    expect(out.notCopied).toHaveLength(1)

    expect(pickFiles([f('big.bin', FILE_LIMITS.fileBytes + 1)], 'all').notCopied[0]!.reason).toBe('file_size')

    const chunk = 20 * 1024 * 1024 // exactly the per-file limit; 102 fit in 2 GB
    const heavy = Array.from({ length: 104 }, (_, i) => f(`h${String(i).padStart(3, '0')}.bin`, chunk))
    const h = pickFiles(heavy, 'all')
    expect(h.copied).toHaveLength(102)
    expect(h.notCopied).toEqual([
      { path: 'h102.bin', size: chunk, reason: 'total_size' },
      { path: 'h103.bin', size: chunk, reason: 'total_size' },
    ])
  })

  it('lists submodules (with their pinned sha), symlinks and names Drive can’t hold, without spending limits', () => {
    const pinned = 'a1b2c3d4e5'.padEnd(40, '0')
    const out = pickFiles(
      [
        f('vendor/lib', null, { mode: '160000', sha: pinned }),
        f('docs/top.md', 13, { mode: '120000' }),
        f('docs/weird\\name.md', 31),
        f('a/./x', 1), // a '.' segment
        f('too-long/' + 'x'.repeat(256), 1),
        f('README.md', 10),
      ],
      'all',
    )
    expect(out.copied.map((e) => e.path)).toEqual(['README.md'])
    expect(out.notCopied).toEqual([
      { path: 'docs/top.md', size: 13, reason: 'symlink' },
      { path: 'docs/weird\\name.md', size: 31, reason: 'name' },
      { path: `too-long/${'x'.repeat(256)}`, size: 1, reason: 'name' },
      { path: 'vendor/lib', size: 0, reason: 'submodule', sha: pinned },
      { path: 'a/./x', size: 1, reason: 'name' },
    ])
  })

  it('docs mode keeps today’s file set: only .md/.mdx, others out of scope entirely', () => {
    const out = pickFiles([f('README.md', 10), f('docs/guide/intro.mdx', 10), f('src/index.ts', 999), f('media/iso.bin', 21 * 1024 * 1024)], 'docs')
    expect(out.copied.map((e) => e.path)).toEqual(['README.md', 'docs/guide/intro.mdx'])
    expect(out.notCopied).toEqual([])
  })

  it('fails loud on a regular entry without a size (the contract says only gitlinks have none)', () => {
    expect(() => pickFiles([{ path: 'x.ts', size: null, mode: '100644', sha: 's' }], 'all')).toThrow(/no size/)
  })
})
