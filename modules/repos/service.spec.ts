import { describe, expect, it } from 'vitest'
import { CLASSIC_TOKEN_MESSAGE, ReposError } from './errors'
import { REPOS_DRIVE_SOURCE as SRC } from './manifest'
import { sealToken, tokenSealKey, unsealToken } from './seal'
import { MASTER, TOKEN, setup } from './test-setup'
import { sampleRepo, tokenError } from './testing'

describe('token sealing', () => {
  it('round-trips, is bound to the row id, and needs TENANT_MASTER_KEY', () => {
    const key = tokenSealKey(MASTER)
    const sealed = sealToken(TOKEN, key, 'row-1')
    expect(sealed).not.toContain(TOKEN)
    expect(unsealToken(sealed, key, 'row-1')).toBe(TOKEN)
    expect(() => unsealToken(sealed, key, 'row-2')).toThrow()
    expect(() => unsealToken(sealed, tokenSealKey('other'), 'row-1')).toThrow()
    expect(() => tokenSealKey(undefined)).toThrow('TENANT_MASTER_KEY is required')
    expect(() => tokenSealKey('  ')).toThrow('TENANT_MASTER_KEY is required')
  })
})

describe('pasting a token (live check)', () => {
  it('stores it sealed with its login, last 4 characters and expiry', async () => {
    const t = setup()
    const { id, login } = await t.service.addToken('user-1', `  ${TOKEN}\n`)
    expect(login).toBe('ada')
    const row = t.store.tokenRows.get(id)!
    expect(row).toMatchObject({ githubLogin: 'ada', last4: '9z9z', expiresAt: new Date('2027-01-31T00:00:00Z'), addedBy: 'user-1' })
    expect(row.tokenSealed).not.toContain(TOKEN)
    expect(unsealToken(row.tokenSealed, tokenSealKey(MASTER), id)).toBe(TOKEN)
    const [view] = await t.service.tokens()
    expect(view).toMatchObject({ login: 'ada', last4: '9z9z', expiresSoon: false, expired: false })
    expect(JSON.stringify(view)).not.toContain(TOKEN)
  })

  it('refuses a classic token, with the plain reason', async () => {
    const t = setup()
    t.gh.identities.set('ghp_classic', { login: 'ada', expiresAt: null, classic: true })
    await expect(t.service.addToken('user-1', 'ghp_classic')).rejects.toThrow(CLASSIC_TOKEN_MESSAGE)
    expect(t.store.tokenRows.size).toBe(0)
  })

  it('refuses a token GitHub does not accept, without echoing it', async () => {
    const t = setup()
    const err = await t.service.addToken('user-1', 'github_pat_wrong123').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ReposError)
    expect((err as Error).message).toBe('GitHub did not accept this token. Check that you copied all of it.')
    expect((err as Error).message).not.toContain('github_pat_wrong123')
    await expect(t.service.addToken('user-1', '   ')).rejects.toThrow('Paste the token from GitHub.')
  })

  it('warns 7 days before the token expires', async () => {
    const t = setup('2027-01-25T00:00:00Z')
    await t.service.addToken('user-1', TOKEN)
    expect((await t.service.tokens())[0]!.expiresSoon).toBe(true)
  })
})

describe('picking repos', () => {
  it('lists what the token can see with whether each syncs; ticking makes it due now', async () => {
    const t = setup()
    const { id } = await t.service.addToken('user-1', TOKEN)
    expect((await t.service.visibleRepos(id)).map((r) => [r.fullName, r.syncing])).toEqual([['kindred/shop', false]])
    await t.service.setRepo(id, 4242, true)
    expect((await t.service.visibleRepos(id))[0]!.syncing).toBe(true)
    expect((await t.store.sources())[0]!.dueAt).toEqual(t.clock.now)
  })

  it('refuses a repo the token cannot see', async () => {
    const t = setup()
    const { id } = await t.service.addToken('user-1', TOKEN)
    await expect(t.service.setRepo(id, 999, true)).rejects.toThrow('This token cannot see that repo.')
  })

  it("unticking deletes the repo's Drive folder (and the empty owner folder)", async () => {
    const t = setup()
    const id = await t.connect()
    await t.service.tick()
    expect(t.drive.keys(SRC).length).toBeGreaterThan(0)
    await t.service.setRepo(id, 4242, false)
    expect(t.drive.keys(SRC)).toEqual([])
    expect((await t.service.list()).length).toBe(0)
    expect((await t.service.tick()).claimed).toBe(0)
  })

  it('removing the token stops its repos and deletes their folders', async () => {
    const t = setup()
    const id = await t.connect()
    await t.service.tick()
    expect(await t.service.removeToken(id)).toEqual({ removedRepos: 1 })
    expect(t.drive.keys(SRC)).toEqual([])
    expect(await t.service.tokens()).toEqual([])
    expect(await t.store.sources()).toEqual([])
  })

  it('a repo syncs through one token only', async () => {
    const t = setup()
    await t.connect()
    t.gh.identities.set('github_pat_second', { login: 'grace', expiresAt: null, classic: false })
    t.gh.visible.set('github_pat_second', ['kindred/shop'])
    const second = await t.service.addToken('user-1', 'github_pat_second')
    await expect(t.service.setRepo(second.id, sampleRepo().repo.id, true)).rejects.toThrow('kindred/shop already syncs through the token of ada.')
  })

  it('an empty list when the org has not approved the token yet', async () => {
    const t = setup()
    t.gh.identities.set('github_pat_org', { login: 'ada', expiresAt: null, classic: false })
    const { id } = await t.service.addToken('user-1', 'github_pat_org')
    expect(await t.service.visibleRepos(id)).toEqual([])
  })
})

describe('sync now and the repo list', () => {
  it('syncs right away and reports status with the Drive folder id', async () => {
    const t = setup()
    await t.connect()
    const out = await t.service.syncNow({ repo: 'Kindred/Shop' })
    expect(out).toEqual({ fullName: 'kindred/shop', outcome: { status: 'synced', changed: true } })
    const [row] = await t.service.list()
    expect(row).toMatchObject({ fullName: 'kindred/shop', lastError: null, driveFolderId: t.drive.file(SRC, 'repo:4242')!.itemId })
  })

  it('does not run while another process holds the repo', async () => {
    const t = setup()
    await t.connect()
    const [s] = await t.store.sources()
    await t.store.claimDue({ owner: 'other-slot', limit: 1, now: t.clock.now, leaseMs: 60_000 })
    expect((await t.service.syncNow({ sourceId: s!.id })).outcome).toEqual({ status: 'queued' })
  })

  it('refuses while paused for the rate limit, and for an unknown repo', async () => {
    const t = setup()
    await t.connect()
    t.gh.failures.push({ method: 'repo', error: tokenError('rate_limited', { resumeAt: new Date('2026-11-12T14:05:00Z') }) })
    await t.service.tick()
    await expect(t.service.syncNow({ repo: 'kindred/shop' })).rejects.toThrow("Syncing is paused until 14:05 UTC (GitHub's rate limit).")
    await expect(t.service.syncNow({ repo: 'nope/nope' })).rejects.toThrow('That repo is not connected.')
  })
})
