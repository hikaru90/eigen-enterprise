import type { RepoSnapshot } from './snapshot-types'
import { describe, expect, it, vi } from 'vitest'
import { LlmHttpError, LlmNotConfiguredError } from '$lib/server/llm/errors'
import { takeSnapshot } from './snapshot'
import {
  buildSummaryMessages,
  createSummarizer,
  deltaIsEmpty,
  diffSnapshots,
  firstSentence,
  parseSummaryOutput,
  SUMMARY_LOG_CONTEXT,
  SUMMARY_MAX_ATTEMPTS,
} from './summary'
import { FakeGitHub, commit, pull, sampleRepo, type FakeRepoData } from './testing'

const TOKEN = 'github_pat_summary'

async function snap(d: FakeRepoData, at: string, prev: RepoSnapshot | null = null): Promise<RepoSnapshot> {
  const gh = new FakeGitHub()
  gh.identities.set(TOKEN, { login: 'ada', expiresAt: null, classic: false })
  gh.addRepo(d, [TOKEN])
  const r = await takeSnapshot(gh.client(TOKEN), { fullName: d.repo.fullName, etags: {}, branchHeads: {}, docShas: {}, snapshot: prev }, new Date(at))
  return r.snapshot
}

const answer = (content: unknown) => ({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] })
const GOOD = {
  summary: 'Cart totals is close to done. Checkout was merged last week.',
  highlights: [
    { kind: 'pr', text: 'Cart totals is still a draft', ref: '#7' },
    { kind: 'branch', text: 'New branch for coupons', ref: 'feature/coupons' },
  ],
}

describe('diffSnapshots (what changed between two syncs, mechanically)', () => {
  it('the first sync: everything in the window is new', async () => {
    const s = await snap(sampleRepo(), '2026-11-12T14:00:00Z')
    const d = diffSnapshots(null, s)
    expect(d.first).toBe(true)
    expect(d.newCommits.map((c) => c.subject).sort()).toEqual(['Cart totals', 'Fix | price rounding', 'Release 1.2'])
    expect(d.prsOpened.map((p) => p.number)).toEqual([7])
    expect(d.prsMerged.map((p) => p.number)).toEqual([5])
    expect(deltaIsEmpty(d)).toBe(false)
  })

  it('a later sync: new commits by sha, branches created/deleted, PRs opened, merged, closed', async () => {
    const d0 = sampleRepo()
    d0.pulls.push(pull({ number: 9, title: 'Wishlist', headRef: 'wishlist' }))
    const before = await snap(d0, '2026-11-12T14:00:00Z')
    const d1 = sampleRepo()
    d1.branches = d1.branches.filter((b) => b.name !== 'old/spike')
    d1.branches.push({ name: 'feature/coupons', headSha: 'd4'.padEnd(40, '0') })
    d1.commits['feature/coupons'] = [commit('d4', 'Coupons', '2026-11-12T14:05:00Z')]
    d1.pulls[0] = { ...d1.pulls[0]!, state: 'closed', merged: true, closedAt: new Date('2026-11-12T14:06:00Z'), mergedAt: new Date('2026-11-12T14:06:00Z'), updatedAt: new Date('2026-11-12T14:06:00Z') }
    d1.pulls.push(pull({ number: 9, title: 'Wishlist', headRef: 'wishlist', state: 'closed', closedAt: new Date('2026-11-12T14:07:00Z'), updatedAt: new Date('2026-11-12T14:07:00Z') }))
    d1.pulls.push(pull({ number: 10, title: 'Coupons', headRef: 'feature/coupons', createdAt: new Date('2026-11-12T14:08:00Z'), updatedAt: new Date('2026-11-12T14:08:00Z') }))
    const after = await snap(d1, '2026-11-12T14:15:00Z')
    const d = diffSnapshots(before, after)
    expect(d.first).toBe(false)
    expect(d.newCommits.map((c) => [c.branch, c.subject])).toEqual([['feature/coupons', 'Coupons']])
    expect(d.branchesCreated).toEqual(['feature/coupons'])
    expect(d.branchesDeleted).toEqual(['old/spike'])
    expect(d.prsOpened.map((p) => p.number)).toEqual([10])
    expect(d.prsMerged.map((p) => p.number)).toEqual([7])
    expect(d.prsClosed.map((p) => p.number)).toEqual([9])
  })

  it('an old open PR that only now shows up (created before the last sync) is not "opened"', async () => {
    const before = await snap(sampleRepo(), '2026-11-12T14:00:00Z')
    const d1 = sampleRepo()
    d1.pulls.push(pull({ number: 2, title: 'Ancient', createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-02-01T00:00:00Z') }))
    const d = diffSnapshots(before, await snap(d1, '2026-11-12T14:15:00Z'))
    expect(d.prsOpened).toEqual([])
    expect(deltaIsEmpty(d)).toBe(true)
  })

  it('nothing moved: empty', async () => {
    const s = await snap(sampleRepo(), '2026-11-12T14:00:00Z')
    expect(deltaIsEmpty(diffSnapshots(s, { ...structuredClone(s), takenAt: '2026-11-12T14:15:00Z' }))).toBe(true)
  })
})

describe('summary output (JSON schema, then validate only)', () => {
  it('accepts the schema and trims', () => {
    expect(parseSummaryOutput(answer({ ...GOOD, summary: `  ${GOOD.summary}  ` }))).toEqual(GOOD)
  })

  it('refuses anything else', () => {
    expect(() => parseSummaryOutput(answer({ summary: '', highlights: [] }))).toThrow()
    expect(() => parseSummaryOutput(answer({ summary: 'x', highlights: [{ kind: 'issue', text: 'y', ref: null }] }))).toThrow()
    expect(() => parseSummaryOutput(answer({ summary: 'x', highlights: [], extra: 1 }))).toThrow()
    expect(() => parseSummaryOutput(answer('not json'))).toThrow()
  })

  it('the prompt carries the delta and the previous summary as JSON', async () => {
    const s = await snap(sampleRepo(), '2026-11-12T14:00:00Z')
    const [system, user] = buildSummaryMessages({ snapshot: s, delta: diffSnapshots(null, s), previous: { ...GOOD, writtenAt: '2026-11-11T10:00:00Z' } })
    expect(system!.content).toContain('"summary"')
    expect(system!.content).toContain('branch | pr | commit | release | other')
    expect(user!.content).toContain('kindred/shop')
    expect(user!.content).toContain('Cart totals is close to done.')
    expect(user!.content).toContain('Release 1.2')
  })

  it('firstSentence: up to the first sentence end, mechanically', () => {
    expect(firstSentence('Cart totals is close to done. Checkout was merged.')).toBe('Cart totals is close to done.')
    expect(firstSentence('No full stop here')).toBe('No full stop here')
    expect(firstSentence('Line one\nLine two')).toBe('Line one')
    expect(firstSentence(`${'a'.repeat(300)}.`)).toHaveLength(200)
  })
})

describe('the summarizer (one gateway call, cost attributed to repos)', () => {
  const input = async () => {
    const s = await snap(sampleRepo(), '2026-11-12T14:00:00Z')
    return { snapshot: s, delta: diffSnapshots(null, s), previous: null }
  }

  it('calls the gateway once with the repos log context and JSON mode, on the company account', async () => {
    const chat = vi.fn(async (_: unknown) => answer(GOOD))
    const summarize = createSummarizer({ chat, account: async () => 'owner-1' })
    expect(await summarize(await input())).toEqual({ status: 'written', ...GOOD })
    expect(chat).toHaveBeenCalledTimes(1)
    expect(chat.mock.calls[0]![0]).toMatchObject({ userId: 'owner-1', logContext: SUMMARY_LOG_CONTEXT, responseFormat: 'json_object', temperature: 0 })
    expect(SUMMARY_LOG_CONTEXT).toBe('repos_summary')
  })

  it('no model selected (the gateway refuses before any request) → no_model, not an error', async () => {
    const chat = vi.fn(async () => {
      throw new LlmNotConfiguredError('No chat model configured')
    })
    expect(await createSummarizer({ chat, account: async () => 'owner-1' })(await input())).toMatchObject({ status: 'no_model' })
    expect(await createSummarizer({ chat, account: async () => null })(await input())).toMatchObject({ status: 'no_model' })
  })

  it(`retries an unreadable answer ${SUMMARY_MAX_ATTEMPTS} times, then fails loud; a refusal is not retried`, async () => {
    const bad = vi.fn(async () => answer('nope'))
    await expect(createSummarizer({ chat: bad, account: async () => 'o' })(await input())).rejects.toThrow(/could not be read/)
    expect(bad).toHaveBeenCalledTimes(SUMMARY_MAX_ATTEMPTS)
    const refused = vi.fn(async () => {
      throw new LlmHttpError(500, 'boom')
    })
    await expect(createSummarizer({ chat: refused, account: async () => 'o' })(await input())).rejects.toThrow(LlmHttpError)
    expect(refused).toHaveBeenCalledTimes(1)
  })
})
