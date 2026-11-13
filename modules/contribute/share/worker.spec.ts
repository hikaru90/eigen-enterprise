import { describe, expect, it } from 'vitest'
import { LlmNotConfiguredError } from '$lib/server/llm/errors'
import { shareProposal, updateProposal, voteProposal } from '../service'
import { fixture } from '../test-fixtures'
import { HUB_CONTRIBUTION_KEYS, hubContributionV1, hubRegisterV1, verifyHubRequest } from './contract'
import { HUB_NOT_CONFIGURED, type HubConfig, type HubRequest, type HubResponse } from './hub'
import { memoryInstallKeyStore } from './identity'
import { ScrubFailedError, type ScrubResult } from './scrub'
import { BACKOFF_CAP_MS, backoffMs, NO_PROVIDER_MESSAGE, runShareTick, SHARE_BATCH, withdrawEverything, type ShareWorkerDeps } from './worker'

const TITLE = 'Ana: upload to https://kindred.example/drive breaks for big files'
const owner = { id: 'owner', kind: 'human' as const, canManage: true }

/** A fake central board: verifies every signature against the registered key, answers from a script. */
function fakeHub() {
  const requests: HubRequest[] = []
  const answers: Array<number | Error> = []
  let publicKey: string | null = null
  const transport = async (req: HubRequest): Promise<HubResponse> => {
    requests.push(req)
    if (req.method === 'POST') publicKey = hubRegisterV1.parse(JSON.parse(req.body)).public_key
    const v = verifyHubRequest({ method: req.method, path: req.path, body: req.body, headers: req.headers, publicKey: publicKey!, now: Number(req.headers['x-ee-timestamp']) })
    if (!v.ok) throw new Error(`fake hub: bad signature (${v.reason})`)
    const next = answers.shift() ?? 200
    if (next instanceof Error) throw next
    return { status: next, text: next >= 400 ? `nope ${next}` : '' }
  }
  return { requests, answers, transport, puts: () => requests.filter((r) => r.method === 'PUT') }
}

function setup(opts: { hub?: HubConfig; scrub?: (t: string) => Promise<ScrubResult>; sharing?: boolean } = {}) {
  const f = fixture([], { sharing: opts.sharing })
  const hub = fakeHub()
  const keys = memoryInstallKeyStore()
  const scrubbed: string[] = []
  const deps: ShareWorkerDeps = {
    share: f.share,
    contributions: f.store,
    keys,
    hub: () => opts.hub ?? { ok: true, url: 'https://hub.test' },
    transport: (origin) => {
      expect(origin).toBe('https://hub.test')
      return hub.transport
    },
    scrub:
      opts.scrub ??
      (async (title) => {
        scrubbed.push(title)
        return { summary: 'Drive upload fails for large files.', language: 'en', removed: ['person', 'url'] }
      }),
    appVersion: '0.5.9',
    now: f.now,
  }
  const propose = (title = TITLE) => shareProposal(f.deps, 'ana', { title, kind: 'bug', area: 'drive' })
  return { f, hub, keys, deps, scrubbed, propose }
}

describe('share worker', () => {
  it('first send: makes the key, registers, scrubs, PUTs exactly the contract fields — never the title or a name', async () => {
    const s = setup()
    const p = await s.propose()
    const out = await runShareTick(s.deps)
    expect(out).toMatchObject({ skipped: null, claimed: 1, sent: 1 })
    const [register, put] = s.hub.requests
    expect(register).toMatchObject({ method: 'POST', path: '/api/hub/register' })
    expect(JSON.parse(register.body)).toMatchObject({ v: 1, install_id: s.keys.key!.installId, public_key: s.keys.key!.publicKey, app_version: '0.5.9' })
    expect(put).toMatchObject({ method: 'PUT', path: `/api/hub/contributions/${p.id}` })
    const body = JSON.parse(put.body)
    expect(Object.keys(body).sort()).toEqual([...HUB_CONTRIBUTION_KEYS].sort())
    expect(hubContributionV1.parse(body)).toMatchObject({ remote_id: p.id, summary: 'Drive upload fails for large files.', score: 1, created_day: '2026-11-10' })
    for (const leak of ['Ana', 'kindred', 'https://', 'ana']) expect(put.body).not.toContain(leak)
    expect(s.scrubbed).toEqual([TITLE])
    expect(await s.f.share.settings()).toMatchObject({ installId: s.keys.key!.installId, lastError: null })
    expect((await s.f.share.settings()).registeredAt).not.toBeNull()
    expect(await s.f.share.entry(p.id)).toMatchObject({ state: 'sent', summary: 'Drive upload fails for large files.', language: 'en', attempts: 0 })
  })

  it('a vote re-sends with the new score, reusing the summary; nothing changed → nothing sent', async () => {
    const s = setup()
    const p = await s.propose()
    await runShareTick(s.deps)
    await voteProposal(s.f.deps, 'ben', p.id, 1)
    expect(await runShareTick(s.deps)).toMatchObject({ sent: 1 })
    expect(JSON.parse(s.hub.puts()[1].body).score).toBe(2)
    expect(s.scrubbed).toHaveLength(1)
    // A vote and its take-back: the snapshot equals what the hub has → no PUT.
    await voteProposal(s.f.deps, 'ben', p.id, 0)
    await voteProposal(s.f.deps, 'ben', p.id, 1)
    expect(await runShareTick(s.deps)).toMatchObject({ unchanged: 1, sent: 0 })
    expect(s.hub.puts()).toHaveLength(2)
    expect((await s.f.share.entry(p.id))?.state).toBe('sent')
    // A status change goes out too.
    await updateProposal(s.f.deps, owner, p.id, { status: 'shipped' })
    await runShareTick(s.deps)
    expect(JSON.parse(s.hub.puts()[2].body)).toMatchObject({ status: 'shipped', shipped_day: '2026-11-10' })
  })

  it('network, 5xx and 429 back off 1 min doubling, capped at 6 h, with no attempt limit', async () => {
    const s = setup()
    const p = await s.propose()
    await runShareTick(s.deps) // registered + sent
    await voteProposal(s.f.deps, 'ben', p.id, 1)
    s.hub.answers.push(503)
    const t0 = s.f.now()
    expect(await runShareTick(s.deps)).toMatchObject({ retried: 1 })
    let e = await s.f.share.entry(p.id)
    expect(e).toMatchObject({ state: 'scrubbed', attempts: 1, lastError: 'The central board answered HTTP 503: nope 503' })
    expect(e!.nextAttemptAt.getTime() - t0.getTime()).toBeGreaterThanOrEqual(60_000)
    expect(await runShareTick(s.deps)).toMatchObject({ claimed: 0 })
    s.f.tick(61_000)
    s.hub.answers.push(429)
    await runShareTick(s.deps)
    e = await s.f.share.entry(p.id)
    expect(e).toMatchObject({ attempts: 2 })
    s.f.tick(121_000)
    s.hub.answers.push(new Error('ECONNREFUSED'))
    await runShareTick(s.deps)
    expect((await s.f.share.entry(p.id))?.lastError).toContain('could not be reached: ECONNREFUSED')
    expect([1, 2, 3, 10, 50].map(backoffMs)).toEqual([60_000, 120_000, 240_000, Math.min(60_000 * 512, BACKOFF_CAP_MS), BACKOFF_CAP_MS])
    s.f.tick(241_000)
    expect(await runShareTick(s.deps)).toMatchObject({ sent: 1 })
    expect(await s.f.share.entry(p.id)).toMatchObject({ state: 'sent', attempts: 0, lastError: null })
  })

  it('another 4xx is failed with the reason and never retried', async () => {
    const s = setup()
    const p = await s.propose()
    s.hub.answers.push(200, 422)
    expect(await runShareTick(s.deps)).toMatchObject({ failed: 1 })
    expect(await s.f.share.entry(p.id)).toMatchObject({ state: 'failed', lastError: 'The central board answered HTTP 422: nope 422' })
    s.f.tick(BACKOFF_CAP_MS * 2)
    expect(await runShareTick(s.deps)).toMatchObject({ skipped: 'nothing_due' })
  })

  it('401/403 on a send or on register: the install is revoked, shown, and nothing more is sent', async () => {
    const s = setup()
    const a = await s.propose('one')
    await s.propose('two')
    s.hub.answers.push(200, 403)
    await runShareTick(s.deps)
    const settings = await s.f.share.settings()
    expect(settings.revokedAt).not.toBeNull()
    expect(settings.lastError).toContain('refused this install (HTTP 403)')
    expect(s.hub.puts()).toHaveLength(1)
    expect((await s.f.share.entry(a.id))?.state).not.toBe('failed')
    expect(await runShareTick(s.deps)).toMatchObject({ skipped: 'revoked' })

    const r = setup()
    await r.propose()
    r.hub.answers.push(401)
    expect(await runShareTick(r.deps)).toMatchObject({ skipped: 'revoked' })
    expect(r.hub.puts()).toHaveLength(0)
  })

  it('a failed register is shown and retried on the next tick; nothing is sent meanwhile', async () => {
    const s = setup()
    await s.propose()
    s.hub.answers.push(500)
    expect(await runShareTick(s.deps)).toMatchObject({ skipped: 'not_registered' })
    expect((await s.f.share.settings()).lastError).toContain('Registering with the central board failed. The central board answered HTTP 500')
    const id = s.keys.key!.installId
    expect(await runShareTick(s.deps)).toMatchObject({ sent: 1 })
    expect(s.keys.key!.installId).toBe(id)
    expect(s.hub.requests.filter((r) => r.method === 'POST')).toHaveLength(2)
  })

  it('a registered install without its key fails loud instead of making a new identity', async () => {
    const s = setup()
    await s.propose()
    await s.f.share.setInstallId('11111111-1111-4111-8111-111111111111', s.f.now())
    expect(await runShareTick(s.deps)).toMatchObject({ skipped: 'not_registered' })
    expect((await s.f.share.settings()).lastError).toContain('signing key is missing')
    expect(s.keys.key).toBeNull()
    expect(s.hub.requests).toHaveLength(0)
  })

  it('scrub: no AI provider → stays waiting with the reason; 3 bad answers → failed; never the raw title', async () => {
    let mode: 'none' | 'bad' = 'none'
    const s = setup({
      scrub: async () => {
        if (mode === 'none') throw new LlmNotConfiguredError('no provider')
        throw new ScrubFailedError('The scrub gave no valid answer in 3 attempts')
      },
    })
    const p = await s.propose()
    expect(await runShareTick(s.deps)).toMatchObject({ retried: 1 })
    expect(await s.f.share.entry(p.id)).toMatchObject({ state: 'pending', lastError: NO_PROVIDER_MESSAGE })
    mode = 'bad'
    s.f.tick(61_000)
    expect(await runShareTick(s.deps)).toMatchObject({ failed: 1 })
    expect(await s.f.share.entry(p.id)).toMatchObject({ state: 'failed', summary: null })
    expect(s.hub.puts()).toHaveLength(0)
  })

  it("don't share after sending: the worker DELETEs it from the hub, then leaves it alone", async () => {
    const s = setup()
    const p = await s.propose()
    await runShareTick(s.deps)
    await s.f.share.exclude(p.id, s.f.now())
    expect(await runShareTick(s.deps)).toMatchObject({ withdrawn: 1 })
    expect(s.hub.requests.at(-1)).toMatchObject({ method: 'DELETE', path: `/api/hub/contributions/${p.id}`, body: '' })
    expect(await s.f.share.entry(p.id)).toMatchObject({ state: 'excluded', lastSentHash: null })
    await voteProposal(s.f.deps, 'ben', p.id, 1)
    expect(await runShareTick(s.deps)).toMatchObject({ skipped: 'nothing_due' })
  })

  it("don't share before sending: nothing ever goes out", async () => {
    const s = setup()
    const p = await s.propose()
    await s.f.share.exclude(p.id, s.f.now())
    expect(await runShareTick(s.deps)).toMatchObject({ skipped: 'nothing_due' })
    expect(s.hub.requests).toHaveLength(0)
  })

  it('off, not configured: sends nothing; the batch is 20', async () => {
    const off = setup({ sharing: false })
    await off.propose()
    expect(await runShareTick(off.deps)).toMatchObject({ skipped: 'off' })
    const nc = setup({ hub: { ok: false, reason: 'not_configured', message: HUB_NOT_CONFIGURED } })
    await nc.propose()
    expect(await runShareTick(nc.deps)).toMatchObject({ skipped: 'not_configured' })
    expect(nc.hub.requests).toHaveLength(0)

    const many = setup()
    for (let i = 0; i < SHARE_BATCH + 3; i++) await many.propose(`p${i}`)
    expect(await runShareTick(many.deps)).toMatchObject({ claimed: SHARE_BATCH, sent: SHARE_BATCH })
    expect(await runShareTick(many.deps)).toMatchObject({ claimed: 3 })
  })

  it('withdraw everything: DELETE the install, every row excluded, registers again when switched back on', async () => {
    const s = setup()
    const p = await s.propose()
    await runShareTick(s.deps)
    await withdrawEverything(s.deps)
    const id = s.keys.key!.installId
    expect(s.hub.requests.at(-1)).toMatchObject({ method: 'DELETE', path: `/api/hub/installs/${id}` })
    expect(await s.f.share.entry(p.id)).toMatchObject({ state: 'excluded', lastSentHash: null })
    expect((await s.f.share.settings()).registeredAt).toBeNull()

    s.hub.answers.push(502)
    await expect(withdrawEverything({ ...s.deps, share: s.f.share })).resolves.toBeUndefined() // not registered: nothing on the hub
    const t = setup()
    await t.propose()
    await runShareTick(t.deps)
    t.hub.answers.push(502)
    await expect(withdrawEverything(t.deps)).rejects.toThrow('Deleting from the central board failed. The central board answered HTTP 502')
  })
})
