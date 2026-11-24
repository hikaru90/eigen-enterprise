import { describe, expect, it } from 'vitest'
import { routeOwner } from '$lib/plugins/routes'
import { TEST_ONLY_MODULE_HUB_PUBLIC_KEY_SPKI } from '../../../../../contracts/fixtures/module-hub-test-key'
import { verifyReceipt } from '../../../../../contracts/module-receipt'
import { revokeInstall } from '../../../../../modules/contribute/hub/service'
import { testInstall, type TestInstall } from '../../../../../modules/contribute/hub/test-fixtures'
import { signHubRequest } from '../../../../../modules/contribute/share/contract'
import { MODULE_HUB_PATHS } from '../../../../../modules/module-hub/contract'
import { bundleOf, moduleHubFixture, publishBody } from '../../../../../modules/module-hub/test-fixtures'
import * as runRoute from './[moduleId]/run/+server'
import * as bundleRoute from './bundles/[sha256]/+server'
import * as publishRoute from './publish/+server'

/** The module hub's machine endpoints on one in-memory hub; no session anywhere. */
function wire(active = true) {
  const f = moduleHubFixture()
  const runtime = { active: async () => active, deps: async () => f.deps }
  for (const r of [publishRoute, bundleRoute, runRoute]) r._deps.runtime = runtime
  return f
}

const ORIGIN = 'https://os.cerberusblue.test'
const ev = (request: Request, params: Record<string, string> = {}) => ({ request, url: new URL(request.url), params, locals: { user: null } }) as never

function signedReq(i: TestInstall, method: 'GET' | 'POST' | 'PUT', path: string, body: string, now: number) {
  const sig = signHubRequest({ method, path, body, installId: i.installId, privateKey: i.privateKey, now })
  return new Request(`${ORIGIN}${path}`, { method, body: body === '' ? undefined : body, headers: { 'content-type': 'application/json', ...sig } })
}

describe('/api/hub/modules/*', () => {
  it('answers 404 and stores nothing while the module-hub module is off', async () => {
    const f = wire(false)
    const a = await f.registered(testInstall())
    const b = bundleOf()
    const res = await publishRoute.POST(ev(signedReq(a, 'POST', MODULE_HUB_PATHS.publish, publishBody(b), f.clock.now)))
    expect(res.status).toBe(404)
    expect(f.moduleStore.versionsBySha.size).toBe(0)
  })

  it('publish 201 → receipt; the bundle comes back as bytes; a run report answers the runs', async () => {
    const f = wire()
    const a = await f.registered(testInstall())
    const b = bundleOf()
    const res = await publishRoute.POST(ev(signedReq(a, 'POST', MODULE_HUB_PATHS.publish, publishBody(b), f.clock.now)))
    expect(res.status).toBe(201)
    const { receipt } = (await res.json()) as { receipt: unknown }
    expect(verifyReceipt(receipt, [TEST_ONLY_MODULE_HUB_PUBLIC_KEY_SPKI]).ok).toBe(true)

    const got = await bundleRoute.GET(ev(signedReq(a, 'GET', MODULE_HUB_PATHS.bundle(b.sha256), '', f.clock.now + 1), { sha256: b.sha256 }))
    expect([got.status, got.headers.get('content-type')]).toEqual([200, 'application/gzip'])
    expect(Buffer.from(await got.arrayBuffer()).equals(Buffer.from(b.bytes))).toBe(true)

    const run = JSON.stringify({ v: 1, bundle_sha256: b.sha256, state: 'running' })
    const ran = await runRoute.PUT(ev(signedReq(a, 'PUT', MODULE_HUB_PATHS.run('hello'), run, f.clock.now + 2), { moduleId: 'hello' }))
    expect(ran.status).toBe(200)
  })

  it('a replay is 401, a revoked install 403, a refusal 422 with its problems', async () => {
    const f = wire()
    const a = await f.registered(testInstall())
    const b = bundleOf()
    const req = () => signedReq(a, 'POST', MODULE_HUB_PATHS.publish, publishBody(b), f.clock.now)
    expect((await publishRoute.POST(ev(req()))).status).toBe(201)
    expect((await publishRoute.POST(ev(req()))).status).toBe(401)
    const bad = await publishRoute.POST(ev(signedReq(a, 'POST', MODULE_HUB_PATHS.publish, publishBody(b, { core_api: '9.0.0' }), f.clock.now + 1)))
    expect(bad.status).toBe(422)
    expect(await bad.json()).toMatchObject({ code: 'refused', problems: [{ check: 'core_api' }] })
    await revokeInstall(f.deps.hub, a.installId)
    expect((await publishRoute.POST(ev(signedReq(a, 'POST', MODULE_HUB_PATHS.publish, publishBody(b), f.clock.now + 2)))).status).toBe(403)
  })

  it('is core to the plugin gate, like the rest of /api/hub', () => {
    expect(routeOwner('/api/hub/modules/publish')).toEqual({ owner: 'core' })
  })
})
