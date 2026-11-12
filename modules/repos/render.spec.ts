import type { RepoSnapshot } from './snapshot-types'
import { describe, expect, it } from 'vitest'
import { render } from './render'
import { pickDocs, takeSnapshot, DOC_LIMITS } from './snapshot'
import { FakeGitHub, pull, sampleRepo } from './testing'

const TOKEN = 'github_pat_render'

async function snapshotOf(mutate: (d: ReturnType<typeof sampleRepo>) => void = () => {}): Promise<RepoSnapshot> {
  const gh = new FakeGitHub()
  gh.identities.set(TOKEN, { login: 'ada', expiresAt: null, classic: false })
  const d = sampleRepo()
  mutate(d)
  gh.addRepo(d, [TOKEN])
  const r = await takeSnapshot(gh.client(TOKEN), { fullName: d.repo.fullName, etags: {}, branchHeads: {}, docShas: {}, snapshot: null }, new Date('2026-11-12T14:00:00Z'))
  return r.snapshot
}

const NONE = { summary: null, problem: null }
const SUMMARY = {
  summary: 'Cart work is nearly done.',
  highlights: [{ kind: 'pr' as const, text: 'Cart totals is in draft', ref: '#7' }],
  writtenAt: '2026-11-12T14:01:00Z',
}

const files = (s: RepoSnapshot, summary: Parameters<typeof render>[1] = NONE) =>
  Object.fromEntries(render(s, summary).flatMap((i) => (i.kind === 'file' ? [[i.key, i.content]] : [])))

describe('render (pure snapshot → Drive files)', () => {
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

  it('says when GitHub truncated the tree, and the file list stays parents-first', async () => {
    const s = await snapshotOf((d) => {
      d.tree!.truncated = true
    })
    expect(files(s)['repo:4242/Overview.md']).toContain('only part of the docs were copied')
    const items = render(s, NONE)
    const seen = new Set<string | null>([null])
    for (const i of items) {
      expect(seen.has(i.parentKey)).toBe(true)
      seen.add(i.key)
    }
  })

  it('renders an empty repo (no branches) without inventing anything', async () => {
    const s = await snapshotOf((d) => {
      d.branches = []
      d.pulls = []
    })
    const f = files(s)
    expect(f['repo:4242/Overview.md']).toContain('No branch had a commit in the last 30 days.')
    expect(f['repo:4242/Activity.md']).toContain('No commits.')
    expect(Object.keys(f).some((k) => k.includes('/Docs/'))).toBe(false)
  })

  it('keeps a quiet branch (no commit in 90 days) in its own table', async () => {
    const f = files(await snapshotOf())['repo:4242/Branches.md']!
    const [main, quiet] = f.split('## Quiet branches')
    expect(main).not.toContain('old/spike')
    expect(quiet).toContain('old/spike')
  })
})

describe('doc limits', () => {
  it('copies at most 300 files, 256 KB each, 10 MB per repo, root README first; lists the rest', () => {
    const many = Array.from({ length: 310 }, (_, i) => ({ path: `a/doc-${String(i).padStart(3, '0')}.md`, sha: `s${i}`, size: 10 }))
    const out = pickDocs([...many, { path: 'README.md', sha: 'r', size: 10 }, { path: 'big.md', sha: 'b', size: DOC_LIMITS.fileBytes + 1 }])
    expect(out.copied).toHaveLength(300)
    expect(out.copied[0]!.path).toBe('README.md')
    expect(out.notCopied.filter((n) => n.reason === 'file_count')).toHaveLength(11)
    expect(out.notCopied.find((n) => n.path === 'big.md')?.reason).toBe('file_size')
    const heavy = Array.from({ length: 41 }, (_, i) => ({ path: `h${i}.md`, sha: `h${i}`, size: 250 * 1024 }))
    const h = pickDocs(heavy)
    expect(h.copied).toHaveLength(40)
    expect(h.notCopied).toEqual([{ path: 'h9.md', size: 250 * 1024, reason: 'total_size' }])
    expect(pickDocs([{ path: 'src/a.ts', sha: 'x', size: 1 }]).copied).toEqual([])
  })
})
