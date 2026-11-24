import { describe, expect, it } from 'vitest'
import { CORE_API_VERSION } from '../../../../contracts/core-api-version'
import { TEST_ONLY_MODULE_HUB_PUBLIC_KEY_SPKI } from '../../../../contracts/fixtures/module-hub-test-key'
import { verifyReceipt } from '../../../../contracts/module-receipt'
import { createHubPublishPort, type ModuleHubTransport } from '../../../../modules/company-modules/publish/client'
import { HUB_NOT_CONFIGURED_SENTENCE, HUB_UNAVAILABLE_SENTENCE, PublishPortError } from '../../../../modules/company-modules/publish/port'
import { generateInstallKey } from '../../../../modules/contribute/share/identity'
import { bundleOf, COMMIT_A, helloFiles, withFile } from '../../../../modules/module-hub/test-fixtures'
import { createMockHub, isModulePath } from '../../../../scripts/mock-hub-core'
import { installSigner } from './publish-port'

const NOW = Date.parse('2026-11-24T12:00:00Z')
const PLANTED = ['sk', 'Qa1Ws2Ed3Rf4Tg5Yh6Uj7Ik8'].join('-')

/** The mock hub (scripts/mock-hub-core.ts) as an in-process transport — the same code mock-hub.ts serves. */
function mockTransport(hub: ReturnType<typeof createMockHub>): ModuleHubTransport {
  return async (req) => {
    if (isModulePath(req.path)) {
      const out = await hub.receiveModules(req.method, req.path, req.headers, req.body)
      return { status: out.status, body: 'bytes' in out ? out.bytes : new TextEncoder().encode(JSON.stringify(out.answer)) }
    }
    const out = hub.receive(req.method, req.path, req.headers, req.body)
    return { status: out.status, body: new TextEncoder().encode(JSON.stringify(out.answer)) }
  }
}

function setup(opts: { hubUrl?: string | undefined; transport?: ModuleHubTransport } = {}) {
  let clock = NOW
  const hub = createMockHub(() => clock)
  const key = generateInstallKey()
  const port = createHubPublishPort({
    hubUrl: () => ('hubUrl' in opts ? opts.hubUrl : 'http://127.0.0.1:5198'),
    identity: async () => installSigner(key),
    transport: () => opts.transport ?? mockTransport(hub),
    appVersion: '0.6.0',
    coreApi: CORE_API_VERSION,
    now: () => new Date((clock += 1)),
  })
  return { hub, key, port }
}

const request = (b = bundleOf()) => ({ moduleId: 'hello', version: '0.1.0', commit: COMMIT_A, manifest: b.manifest, bundle: b.bytes, bundleSha256: b.sha256 })

describe('the box PublishPort against the mock hub', () => {
  it('registers on first use, publishes, reports the run and fetches the bundle back (the round trip)', async () => {
    const { hub, key, port } = setup()
    const b = bundleOf()
    const out = await port.publish(request(b))
    expect(out.created).toBe(true)
    expect(verifyReceipt(out.receipt, [TEST_ONLY_MODULE_HUB_PUBLIC_KEY_SPKI]).ok).toBe(true)
    expect(out.receipt).toMatchObject({ installId: key.installId, moduleId: 'hello', bundleSha256: b.sha256 })
    // 401 (unknown) → register → the same request newly signed.
    expect(hub.requests.map((r) => [r.method, r.path, r.status])).toEqual([
      ['POST', '/api/hub/modules/publish', 401],
      ['POST', '/api/hub/register', 201],
      ['POST', '/api/hub/modules/publish', 201],
    ])

    const again = await port.publish(request(b))
    expect(again).toEqual({ receipt: out.receipt, created: false })

    const runs = await port.reportRun({ moduleId: 'hello', bundleSha256: b.sha256, state: 'running' })
    expect(runs.runs).toEqual([expect.objectContaining({ install_id: key.installId, state: 'running' })])

    const bytes = await port.fetchBundle(b.sha256)
    expect(Buffer.from(bytes).equals(Buffer.from(b.bytes))).toBe(true)
    // Queued after the publish, and again on the repeat while no summary exists (the job queue dedupes).
    expect(new Set(hub.summaryQueue)).toEqual(new Set([b.sha256]))
  })

  it('a refusal carries every problem the hub named (a planted secret by path:line, no value)', async () => {
    const { port } = setup()
    const b = bundleOf(withFile(helloFiles(), 'secret.mjs', `export const k = "${PLANTED}"\n`))
    const err = await port.publish(request(b)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PublishPortError)
    expect(err).toMatchObject({ code: 'hub_refused', status: 422, problems: [{ check: 'secrets', path: 'secret.mjs', line: 1 }] })
    expect((err as Error).message).toContain('secret.mjs:1')
    expect((err as Error).message).not.toContain(PLANTED)
  })

  it('an unknown bundle is hub_not_found', async () => {
    const { port } = setup()
    await port.publish(request())
    await expect(port.fetchBundle('c'.repeat(64))).rejects.toMatchObject({ code: 'hub_not_found', status: 404 })
  })

  it('a stopped hub gives hub_unavailable with the §6.5 sentence', async () => {
    const { port } = setup({
      transport: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5198')
      },
    })
    const err = await port.publish(request()).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'hub_unavailable', reason: 'unreachable', status: null })
    expect((err as Error).message).toContain(HUB_UNAVAILABLE_SENTENCE)
  })

  it('a hub answering 5xx or 429 is hub_unavailable too (no retry loop)', async () => {
    let calls = 0
    const { port } = setup({
      transport: async () => {
        calls++
        return { status: 503, body: new TextEncoder().encode('{"error":"down for maintenance"}') }
      },
    })
    await expect(port.publish(request())).rejects.toMatchObject({ code: 'hub_unavailable', reason: 'busy', status: 503 })
    expect(calls).toBe(1)
  })

  it('without MODULE_HUB_URL it says "module hub not configured" and sends nothing', async () => {
    let calls = 0
    const { port } = setup({
      hubUrl: undefined,
      transport: async () => {
        calls++
        return { status: 200, body: new Uint8Array() }
      },
    })
    const err = await port.publish(request()).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'hub_unavailable', reason: 'not_configured', message: HUB_NOT_CONFIGURED_SENTENCE })
    expect((err as Error).message.toLowerCase()).toContain('module hub not configured')
    expect(calls).toBe(0)
  })

  it('a revoked install is hub_revoked', async () => {
    const { hub, key, port } = setup()
    await port.publish(request())
    hub.hubStore.installs.get(key.installId)!.revokedAt = new Date(NOW)
    await expect(port.reportRun({ moduleId: 'hello', bundleSha256: bundleOf().sha256, state: 'running' })).rejects.toMatchObject({ code: 'hub_revoked', status: 403 })
  })

  it('refuses a receipt that does not match what was published', async () => {
    const real = setup()
    const good = await real.port.publish(request())
    const { port } = setup({
      transport: async () => ({ status: 201, body: new TextEncoder().encode(JSON.stringify({ receipt: { ...good.receipt, commit: 'c'.repeat(40) } })) }),
    })
    await expect(port.publish(request())).rejects.toMatchObject({ code: 'hub_refused', message: expect.stringContaining('commit') })
  })
})
