import { describe, expect, it } from 'vitest'
import { shareProposal, voteProposal } from '../service'
import { fixture } from '../test-fixtures'
import { HUB_CONTRIBUTION_KEYS, verifyHubRequest, type HubContributionV1 } from './contract'
import { HUB_NOT_CONFIGURED, type HubConfig, type HubRequest } from './hub'
import { memoryInstallKeyStore } from './identity'
import { dontShare, itemView, sentPayload, setSharing, shareStatus, sharingStates, type ShareDeps } from './service'
import { runShareTick } from './worker'

function setup(opts: { hub?: HubConfig; providerReady?: boolean } = {}) {
  const f = fixture()
  const requests: HubRequest[] = []
  const answers: number[] = []
  const keys = memoryInstallKeyStore()
  const deps: ShareDeps = {
    share: f.share,
    contributions: f.store,
    keys,
    hub: () => opts.hub ?? { ok: true, url: 'https://hub.test' },
    transport: () => async (req) => {
      requests.push(req)
      if (keys.key && req.method !== 'POST') {
        const v = verifyHubRequest({ ...req, headers: req.headers, publicKey: keys.key.publicKey, now: Number(req.headers['x-ee-timestamp']) })
        if (!v.ok) throw new Error('bad signature')
      }
      return { status: answers.shift() ?? 200, text: '' }
    },
    scrub: async () => ({ summary: 'Search inside Drive files.', language: 'de', removed: ['person'] }),
    appVersion: '0.5.9',
    now: f.now,
    providerReady: async () => opts.providerReady ?? true,
  }
  const propose = () => shareProposal(f.deps, 'ana', { title: 'Olga will Suche in Drive', kind: 'idea', area: 'drive' })
  return { f, deps, requests, answers, propose }
}

const ownerActor = { id: 'owner', isOwner: true }
const admin = { id: 'adm', canManage: true }
const member = { id: 'ben', canManage: false }

describe('sharing: status for Settings', () => {
  it('counts waiting/shared/failed and names a missing hub URL, a missing provider and the last error', async () => {
    const s = setup({ hub: { ok: false, reason: 'not_configured', message: HUB_NOT_CONFIGURED }, providerReady: false })
    await s.propose()
    expect(await shareStatus(s.deps)).toEqual({
      enabled: true,
      notConfigured: HUB_NOT_CONFIGURED,
      revoked: null,
      providerReady: false,
      waiting: 1,
      sent: 0,
      failed: 0,
      withdrawing: 0,
      lastError: null,
    })
    const r = setup()
    await r.propose()
    r.answers.push(200, 500)
    await runShareTick(r.deps)
    const st = await shareStatus(r.deps)
    expect(st).toMatchObject({ waiting: 1, notConfigured: null })
    expect(st.lastError?.message).toContain('HTTP 500')
  })

  it('shows a revoked install', async () => {
    const s = setup()
    await s.propose()
    s.answers.push(403)
    await runShareTick(s.deps)
    expect((await shareStatus(s.deps)).revoked?.message).toContain('refused this install')
  })
})

describe('sharing: the owner switch', () => {
  it('owner only; off stops sending; on again does not backfill what was proposed while off', async () => {
    const s = setup()
    await expect(setSharing(s.deps, { id: 'adm', isOwner: false }, { enabled: false, withdraw: false })).rejects.toThrow(/only the owner/)
    await setSharing(s.deps, ownerActor, { enabled: false, withdraw: false })
    const p = await s.propose()
    expect(await runShareTick(s.deps)).toMatchObject({ skipped: 'off' })
    await setSharing(s.deps, ownerActor, { enabled: true, withdraw: false })
    expect((await sharingStates(s.deps, [p.id]))[p.id].state).toBe('not_shared')
    expect(await runShareTick(s.deps)).toMatchObject({ skipped: 'nothing_due' })
    expect(s.requests).toHaveLength(0)
  })

  it('off + withdraw deletes the install from the hub; a hub failure is shown and sharing stays off', async () => {
    const s = setup()
    const p = await s.propose()
    await runShareTick(s.deps)
    await setSharing(s.deps, ownerActor, { enabled: false, withdraw: true })
    expect(s.requests.at(-1)?.method).toBe('DELETE')
    expect((await sharingStates(s.deps, [p.id]))[p.id]).toEqual({ state: 'not_shared', error: null, withdrawing: false })

    const t = setup()
    await t.propose()
    await runShareTick(t.deps)
    t.answers.push(503)
    await expect(setSharing(t.deps, ownerActor, { enabled: false, withdraw: true })).rejects.toThrow(/^Sharing is off\. Deleting from the central board failed/)
    expect((await t.f.share.settings()).enabled).toBe(false)
    await expect(setSharing(t.deps, ownerActor, { enabled: true, withdraw: true })).rejects.toThrow(/withdraw goes with turning sharing off/)
  })
})

describe('sharing: on the board', () => {
  it('maps each state', () => {
    const base = { contributionId: 'x', summary: null, language: null, lastSentHash: null, attempts: 0, nextAttemptAt: new Date(), lastError: null, sentAt: null, updatedAt: new Date() }
    expect(itemView(null).state).toBe('not_shared')
    expect(itemView({ ...base, state: 'pending', lastError: 'No AI provider' })).toEqual({ state: 'waiting', error: 'No AI provider', withdrawing: false })
    expect(itemView({ ...base, state: 'scrubbed' }).state).toBe('waiting')
    expect(itemView({ ...base, state: 'sent' }).state).toBe('shared')
    expect(itemView({ ...base, state: 'failed', lastError: 'HTTP 422' })).toEqual({ state: 'failed', error: 'HTTP 422', withdrawing: false })
    expect(itemView({ ...base, state: 'excluded', lastSentHash: 'h' })).toEqual({ state: 'not_shared', error: null, withdrawing: true })
  })

  it('show what was sent: the exact payload, whether the hub has it; owner/admins only', async () => {
    const s = setup()
    const p = await s.propose()
    expect(await sentPayload(s.deps, admin, p.id)).toEqual({ sharing: { state: 'waiting', error: null, withdrawing: false }, payload: null, isOnHub: false, sentAt: null })
    await runShareTick(s.deps)
    const sent = await sentPayload(s.deps, admin, p.id)
    expect(sent.isOnHub).toBe(true)
    expect(Object.keys(sent.payload!).sort()).toEqual([...HUB_CONTRIBUTION_KEYS].sort())
    const put = s.requests.find((r) => r.method === 'PUT')!
    expect(sent.payload).toEqual(JSON.parse(put.body) as HubContributionV1)
    expect(JSON.stringify(sent)).not.toContain('Olga')
    await voteProposal(s.f.deps, 'ben', p.id, 1)
    expect((await sentPayload(s.deps, admin, p.id)).isOnHub).toBe(false)
    await expect(sentPayload(s.deps, member, p.id)).rejects.toThrow(/only the owner and admins/)
  })

  it("don't share: owner/admins only; before sending it never leaves, after it is withdrawn", async () => {
    const s = setup()
    const a = await s.propose()
    await expect(dontShare(s.deps, member, a.id)).rejects.toThrow(/only the owner and admins/)
    expect(await dontShare(s.deps, admin, a.id)).toEqual({ state: 'not_shared', error: null, withdrawing: false })
    const b = await s.propose()
    await runShareTick(s.deps)
    expect(s.requests.filter((r) => r.method === 'PUT').map((r) => r.path)).toEqual([`/api/hub/contributions/${b.id}`])
    expect(await dontShare(s.deps, admin, b.id)).toEqual({ state: 'not_shared', error: null, withdrawing: true })
    await runShareTick(s.deps)
    expect(s.requests.at(-1)).toMatchObject({ method: 'DELETE', path: `/api/hub/contributions/${b.id}` })
    expect((await sharingStates(s.deps, [b.id]))[b.id].withdrawing).toBe(false)
    await expect(dontShare(s.deps, admin, '00000000-0000-4000-8000-00000000ffff')).rejects.toThrow(/not found/)
  })
})
