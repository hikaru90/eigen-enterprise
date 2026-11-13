import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { HUB_HEADERS, HUB_MAX_SKEW_MS, HUB_PATHS } from '../contribute/share/contract'
import {
  deleteContribution,
  deleteInstall,
  getHubProposal,
  HUB_RATE_LIMIT_PER_HOUR,
  listHubProposals,
  register,
  revokeInstall,
  upsertContribution,
} from './service'
import { fixture, payload, putReq, registerBody, signed, T0, testInstall } from './test-fixtures'

async function registered() {
  const f = fixture()
  const a = testInstall()
  await register(f.deps, registerBody(a))
  return { ...f, a }
}

describe('register', () => {
  it('stores a new install (201), is idempotent for the same id + key (200), refuses another key (409)', async () => {
    const f = fixture()
    const a = testInstall()
    expect(await register(f.deps, registerBody(a))).toEqual({ status: 201, body: { registered: true, install_id: a.installId } })
    expect(await register(f.deps, registerBody(a, { app_version: '0.6.1' }))).toEqual({
      status: 200,
      body: { registered: true, install_id: a.installId },
    })
    expect((await f.store.getInstall(a.installId))?.appVersion).toBe('0.6.1')
    const other = testInstall()
    await expect(register(f.deps, registerBody(a, { public_key: other.publicKey }))).rejects.toMatchObject({ code: 'conflict' })
    expect((await f.store.getInstall(a.installId))?.publicKey).toBe(a.publicKey)
  })

  it('refuses a body that is not the strict v1 shape or not an Ed25519 key (400)', async () => {
    const f = fixture()
    const a = testInstall()
    await expect(register(f.deps, 'not json')).rejects.toMatchObject({ code: 'invalid' })
    await expect(register(f.deps, registerBody(a, { company: 'Kindred' }))).rejects.toMatchObject({ code: 'invalid' })
    await expect(register(f.deps, registerBody(a, { v: 2 }))).rejects.toMatchObject({ code: 'invalid' })
    await expect(register(f.deps, registerBody(a, { public_key: 'A'.repeat(60) }))).rejects.toMatchObject({ code: 'invalid' })
    expect(await f.store.getInstall(a.installId)).toBeNull()
  })

  it('a revoked install cannot register again (403)', async () => {
    const { deps, a } = await registered()
    await revokeInstall(deps, a.installId)
    await expect(register(deps, registerBody(a))).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('signed requests', () => {
  it('upserts a proposal: created (201), the same body again changes nothing (200 unchanged), a change updates', async () => {
    const { deps, clock, a, store } = await registered()
    const p = payload()
    expect(await upsertContribution(deps, putReq(a, p, clock.now), p.remote_id)).toEqual({ status: 201, body: { outcome: 'created' } })
    const first = await store.get(a.installId, p.remote_id)
    clock.now += 1000
    expect(await upsertContribution(deps, putReq(a, p, clock.now), p.remote_id)).toEqual({ status: 200, body: { outcome: 'unchanged' } })
    expect((await store.get(a.installId, p.remote_id))?.updatedAt).toEqual(first?.updatedAt)
    clock.now += 1000
    expect(await upsertContribution(deps, putReq(a, { ...p, score: 5, status: 'in_progress' }, clock.now), p.remote_id)).toEqual({
      status: 200,
      body: { outcome: 'updated' },
    })
    expect(await store.get(a.installId, p.remote_id)).toMatchObject({ score: 5, status: 'in_progress', receivedAt: first?.receivedAt })
    expect((await store.getInstall(a.installId))?.lastSeenAt).toEqual(new Date(clock.now))
  })

  it('refuses an extra key, a wrong version and a remote id that is not the path (400)', async () => {
    const { deps, clock, a } = await registered()
    const p = payload()
    await expect(upsertContribution(deps, putReq(a, { ...p, author: 'Ana' }, clock.now), p.remote_id)).rejects.toMatchObject({ code: 'invalid' })
    await expect(upsertContribution(deps, putReq(a, { ...p, v: 2 }, clock.now + 1), p.remote_id)).rejects.toMatchObject({ code: 'invalid' })
    const other = randomUUID()
    await expect(upsertContribution(deps, putReq(a, p, clock.now + 2, other), other)).rejects.toMatchObject({ code: 'invalid' })
    const bad = signed(a, 'PUT', HUB_PATHS.contribution(p.remote_id), '{not json', clock.now + 3)
    await expect(upsertContribution(deps, bad, p.remote_id)).rejects.toMatchObject({ code: 'invalid' })
  })

  it('refuses an unknown install, missing headers, a bad signature, a stale timestamp and a replay (401)', async () => {
    const { deps, clock, a } = await registered()
    const p = payload()
    const stranger = testInstall()
    await expect(upsertContribution(deps, putReq(stranger, p, clock.now), p.remote_id)).rejects.toMatchObject({ code: 'unauthorized' })

    const noHeaders = { ...putReq(a, p, clock.now), headers: new Headers({ 'content-type': 'application/json' }) }
    await expect(upsertContribution(deps, noHeaders, p.remote_id)).rejects.toMatchObject({ code: 'unauthorized' })

    // a's id, someone else's key
    const forged = putReq({ ...stranger, installId: a.installId }, p, clock.now)
    await expect(upsertContribution(deps, forged, p.remote_id)).rejects.toMatchObject({ code: 'unauthorized' })

    // body changed after signing
    const tampered = { ...putReq(a, p, clock.now), body: JSON.stringify({ ...p, score: 99 }) }
    await expect(upsertContribution(deps, tampered, p.remote_id)).rejects.toMatchObject({ code: 'unauthorized' })

    const stale = putReq(a, p, clock.now - HUB_MAX_SKEW_MS - 1)
    await expect(upsertContribution(deps, stale, p.remote_id)).rejects.toMatchObject({ code: 'unauthorized' })

    const once = putReq(a, p, clock.now)
    await upsertContribution(deps, once, p.remote_id)
    clock.now += 2000
    await expect(upsertContribution(deps, once, p.remote_id)).rejects.toMatchObject({ code: 'unauthorized', message: /replay/ })
  })

  it('prunes seen signatures that fell out of the skew window', async () => {
    const { deps, clock, a, store } = await registered()
    const p = payload()
    await upsertContribution(deps, putReq(a, p, clock.now), p.remote_id)
    expect(store.signatures.size).toBeGreaterThan(0)
    clock.now += HUB_MAX_SKEW_MS + 60_000
    const q = payload()
    await upsertContribution(deps, putReq(a, q, clock.now), q.remote_id)
    expect(store.signatures.size).toBe(1)
  })

  it('a revoked install gets 403 for every signed request', async () => {
    const { deps, clock, a } = await registered()
    const p = payload()
    await upsertContribution(deps, putReq(a, p, clock.now), p.remote_id)
    await revokeInstall(deps, a.installId)
    await expect(upsertContribution(deps, putReq(a, p, clock.now + 1), p.remote_id)).rejects.toMatchObject({ code: 'forbidden' })
    const del = signed(a, 'DELETE', HUB_PATHS.contribution(p.remote_id), '', clock.now + 2)
    await expect(deleteContribution(deps, del, p.remote_id)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it(`allows ${HUB_RATE_LIMIT_PER_HOUR} requests per install per hour, then 429 until the next hour`, async () => {
    const { deps, clock, a } = await registered()
    const p = payload()
    // register counted as the first request of this hour
    for (let n = 1; n < HUB_RATE_LIMIT_PER_HOUR; n++) {
      clock.now += 1
      await upsertContribution(deps, putReq(a, { ...p, score: n }, clock.now), p.remote_id)
    }
    clock.now += 1
    await expect(upsertContribution(deps, putReq(a, p, clock.now), p.remote_id)).rejects.toMatchObject({ code: 'rate_limited' })
    await expect(register(deps, registerBody(a))).rejects.toMatchObject({ code: 'rate_limited' })
    // another install is not affected
    const b = testInstall()
    await register(deps, registerBody(b))
    clock.now = T0 + 60 * 60 * 1000
    await expect(upsertContribution(deps, putReq(a, p, clock.now), p.remote_id)).resolves.toMatchObject({ status: 200 })
  })

  it('withdraws one proposal (200, idempotent) and refuses a body on DELETE (400)', async () => {
    const { deps, clock, a, store } = await registered()
    const p = payload()
    await upsertContribution(deps, putReq(a, p, clock.now), p.remote_id)
    const del = (n: number, body = '') => signed(a, 'DELETE', HUB_PATHS.contribution(p.remote_id), body, clock.now + n)
    await expect(deleteContribution(deps, del(1, '{}'), p.remote_id)).rejects.toMatchObject({ code: 'invalid' })
    expect(await deleteContribution(deps, del(2), p.remote_id)).toEqual({ status: 200, body: { deleted: true } })
    expect(await store.get(a.installId, p.remote_id)).toBeNull()
    expect(await deleteContribution(deps, del(3), p.remote_id)).toEqual({ status: 200, body: { deleted: false } })
    const notUuid = signed(a, 'DELETE', HUB_PATHS.contribution('nope'), '', clock.now + 4)
    await expect(deleteContribution(deps, notUuid, 'nope')).rejects.toMatchObject({ code: 'invalid' })
  })

  it('deletes an install with everything it shared; another install cannot delete it (403)', async () => {
    const { deps, clock, a, store } = await registered()
    const b = testInstall()
    await register(deps, registerBody(b))
    const p = payload()
    await upsertContribution(deps, putReq(a, p, clock.now), p.remote_id)
    const byB = signed(b, 'DELETE', HUB_PATHS.install(a.installId), '', clock.now + 1)
    await expect(deleteInstall(deps, byB, a.installId)).rejects.toMatchObject({ code: 'forbidden' })
    const byA = signed(a, 'DELETE', HUB_PATHS.install(a.installId), '', clock.now + 2)
    expect(await deleteInstall(deps, byA, a.installId)).toEqual({ status: 200, body: { deleted: true } })
    expect(await store.getInstall(a.installId)).toBeNull()
    expect(await store.get(a.installId, p.remote_id)).toBeNull()
    // gone: it may register afresh, also with a new key
    const fresh = testInstall()
    expect((await register(deps, registerBody({ ...fresh, installId: a.installId }))).status).toBe(201)
  })

  it('the signature covers the path: a request signed for one proposal cannot write another', async () => {
    const { deps, clock, a } = await registered()
    const p = payload()
    const req = putReq(a, p, clock.now)
    const other = randomUUID()
    await expect(upsertContribution(deps, { ...req, path: HUB_PATHS.contribution(other) }, other)).rejects.toMatchObject({
      code: 'unauthorized',
    })
    expect(req.headers.get(HUB_HEADERS.install)).toBe(a.installId)
  })
})

describe('reading and revoking (the owner)', () => {
  it('lists open proposals highest score first, gets one, and revoke is idempotent; unknown ids are 404', async () => {
    const { deps, clock, a } = await registered()
    const low = payload({ score: 1 })
    const high = payload({ score: 7, kind: 'bug', area: 'drive' })
    const done = payload({ status: 'shipped', shipped_day: '2026-11-13' })
    for (const [n, p] of [low, high, done].entries()) await upsertContribution(deps, putReq(a, p, clock.now + n), p.remote_id)
    const open = await listHubProposals(deps, ['requested', 'in_progress'])
    expect(open.map((p) => p.remoteId)).toEqual([high.remote_id, low.remote_id])
    expect(open[0]).toMatchObject({ installId: a.installId, kind: 'bug', area: 'drive', score: 7, language: 'de', createdDay: '2026-11-12' })
    expect(Object.keys(open[0]).sort()).toEqual(
      ['appVersion', 'area', 'createdDay', 'installId', 'kind', 'language', 'receivedAt', 'remoteId', 'score', 'shippedDay', 'status', 'summary', 'updatedAt'].sort(),
    )
    expect((await getHubProposal(deps, a.installId, done.remote_id)).shippedDay).toBe('2026-11-13')
    await expect(getHubProposal(deps, a.installId, randomUUID())).rejects.toMatchObject({ code: 'not_found' })

    const first = await revokeInstall(deps, a.installId)
    clock.now += 5000
    expect(await revokeInstall(deps, a.installId)).toEqual(first)
    await expect(revokeInstall(deps, randomUUID())).rejects.toMatchObject({ code: 'not_found' })
    await expect(revokeInstall(deps, 'not-a-uuid')).rejects.toMatchObject({ code: 'invalid' })
  })
})
