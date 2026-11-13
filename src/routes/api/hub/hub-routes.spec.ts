import { describe, expect, it } from 'vitest'
import { routeOwner } from '$lib/plugins/routes'
import { pluginGate } from '$lib/server/plugins/gate'
import { revokeInstall, HUB_RATE_LIMIT_PER_HOUR } from '../../../../modules/contribute/hub/service'
import { fixture, payload, registerBody, testInstall, type TestInstall } from '../../../../modules/contribute/hub/test-fixtures'
import { HUB_PATHS, signHubRequest } from '../../../../modules/contribute/share/contract'
import * as contributionRoute from './contributions/[remoteId]/+server'
import * as installRoute from './installs/[installId]/+server'
import * as registerRoute from './register/+server'

/** The hub's machine endpoints on one in-memory hub; no session anywhere (locals.user is never read). */
function wire(active = true) {
  const f = fixture()
  const runtime = { active: async () => active, deps: async () => f.deps }
  for (const r of [registerRoute, contributionRoute, installRoute]) r._deps.runtime = runtime
  return f
}

const ORIGIN = 'https://os.cerberusblue.test'
const ev = (request: Request, params: Record<string, string> = {}) =>
  ({ request, url: new URL(request.url), params, locals: { user: null } }) as never

const registerReq = (body: string) =>
  new Request(`${ORIGIN}${HUB_PATHS.register}`, { method: 'POST', body, headers: { 'content-type': 'application/json' } })

function signedReq(i: TestInstall, method: 'PUT' | 'DELETE', path: string, body: string, now: number, headers: Record<string, string> = {}) {
  const sig = signHubRequest({ method, path, body, installId: i.installId, privateKey: i.privateKey, now })
  return new Request(`${ORIGIN}${path}`, {
    method,
    body: body === '' ? undefined : body,
    headers: { 'content-type': 'application/json', ...sig, ...headers },
  })
}

const put = (i: TestInstall, p: Record<string, unknown>, now: number) =>
  contributionRoute.PUT(ev(signedReq(i, 'PUT', HUB_PATHS.contribution(String(p.remote_id)), JSON.stringify(p), now), { remoteId: String(p.remote_id) }))

describe('/api/hub/*', () => {
  it('answers 404 and does nothing while the contribute-hub module is off', async () => {
    const f = wire(false)
    const a = testInstall()
    const p = payload()
    const responses = await Promise.all([
      registerRoute.POST(ev(registerReq(registerBody(a)))),
      put(a, p, f.clock.now),
      contributionRoute.DELETE(ev(signedReq(a, 'DELETE', HUB_PATHS.contribution(p.remote_id), '', f.clock.now), { remoteId: p.remote_id })),
      installRoute.DELETE(ev(signedReq(a, 'DELETE', HUB_PATHS.install(a.installId), '', f.clock.now), { installId: a.installId })),
    ])
    expect(responses.map((r) => r.status)).toEqual([404, 404, 404, 404])
    expect(f.store.installs.size).toBe(0)
  })

  it('register: 201, 200 again, 409 another key, 400 extra key', async () => {
    wire()
    const a = testInstall()
    const r1 = await registerRoute.POST(ev(registerReq(registerBody(a))))
    expect(r1.status).toBe(201)
    expect(await r1.json()).toEqual({ registered: true, install_id: a.installId })
    expect((await registerRoute.POST(ev(registerReq(registerBody(a))))).status).toBe(200)
    expect((await registerRoute.POST(ev(registerReq(registerBody(a, { public_key: testInstall().publicKey }))))).status).toBe(409)
    const extra = await registerRoute.POST(ev(registerReq(registerBody(testInstall(), { hostname: 'kindred.example' }))))
    expect(extra.status).toBe(400)
    expect(await extra.json()).toMatchObject({ code: 'invalid' })
  })

  it('contributions: 201 created, 200 unchanged, 400 extra key, 401 unsigned / replayed, 403 revoked, 429 over the limit', async () => {
    const f = wire()
    const a = testInstall()
    await registerRoute.POST(ev(registerReq(registerBody(a))))
    const p = payload()
    const created = await put(a, p, f.clock.now)
    expect(created.status).toBe(201)
    expect(await created.json()).toEqual({ outcome: 'created' })
    const again = await put(a, p, f.clock.now + 1)
    expect([again.status, await again.json()]).toEqual([200, { outcome: 'unchanged' }])
    expect((await put(a, { ...p, author_name: 'Ana' }, f.clock.now + 2)).status).toBe(400)

    const unsigned = new Request(`${ORIGIN}${HUB_PATHS.contribution(p.remote_id)}`, { method: 'PUT', body: JSON.stringify(p), headers: { 'content-type': 'application/json' } })
    expect((await contributionRoute.PUT(ev(unsigned, { remoteId: p.remote_id }))).status).toBe(401)

    const replay = signedReq(a, 'PUT', HUB_PATHS.contribution(p.remote_id), JSON.stringify(p), f.clock.now + 3)
    expect((await contributionRoute.PUT(ev(replay.clone(), { remoteId: p.remote_id }))).status).toBe(200)
    expect((await contributionRoute.PUT(ev(replay, { remoteId: p.remote_id }))).status).toBe(401)

    const b = testInstall()
    await registerRoute.POST(ev(registerReq(registerBody(b))))
    for (let n = 1; n < HUB_RATE_LIMIT_PER_HOUR; n++) await put(b, { ...p, score: n }, f.clock.now + 10 + n)
    const limited = await put(b, p, f.clock.now + 100)
    expect([limited.status, (await limited.json()).code]).toEqual([429, 'rate_limited'])

    await revokeInstall(f.deps, a.installId)
    const revoked = await put(a, p, f.clock.now + 200)
    expect([revoked.status, (await revoked.json()).code]).toEqual([403, 'forbidden'])
  })

  it('DELETE one proposal (200) and the whole install (200; another install 403)', async () => {
    const f = wire()
    const a = testInstall()
    const b = testInstall()
    for (const i of [a, b]) await registerRoute.POST(ev(registerReq(registerBody(i))))
    const p = payload()
    await put(a, p, f.clock.now)
    const one = await contributionRoute.DELETE(
      ev(signedReq(a, 'DELETE', HUB_PATHS.contribution(p.remote_id), '', f.clock.now + 1), { remoteId: p.remote_id }),
    )
    expect([one.status, await one.json()]).toEqual([200, { deleted: true }])

    const byB = await installRoute.DELETE(ev(signedReq(b, 'DELETE', HUB_PATHS.install(a.installId), '', f.clock.now + 2), { installId: a.installId }))
    expect(byB.status).toBe(403)
    const byA = await installRoute.DELETE(ev(signedReq(a, 'DELETE', HUB_PATHS.install(a.installId), '', f.clock.now + 3), { installId: a.installId }))
    expect([byA.status, await byA.json()]).toEqual([200, { deleted: true }])
    expect(f.store.installs.has(a.installId)).toBe(false)
  })

  it('an unexpected failure is a 500 with its message', async () => {
    const f = wire()
    f.store.getInstall = async () => {
      throw new Error('db down')
    }
    const res = await registerRoute.POST(ev(registerReq(registerBody(testInstall()))))
    expect([res.status, (await res.json()).error]).toEqual([500, 'db down'])
  })

  it('is core to the plugin gate: a signed-out machine request passes it, whatever the plugins', async () => {
    expect(routeOwner('/api/hub/register')).toEqual({ owner: 'core' })
    expect(routeOwner('/api/hub/contributions/x')).toEqual({ owner: 'core' })
    const decision = await pluginGate(
      { pathname: '/api/hub/register', method: 'POST', isDataRequest: false, headers: new Headers(), userId: null },
      { activations: async () => new Map(), pluginName: async () => 'x', canManage: async () => false, log: () => {} },
    )
    expect(decision).toEqual({ kind: 'pass' })
  })
})
