/**
 * The mock central Contribute board's logic (scripts/mock-hub.ts serves it).
 * It speaks the hub API of modules/contribute/share/contract.ts with the
 * contract's own code — never a copy of it: register parses hubRegisterV1;
 * every other request must pass verifyHubRequest against the registered key
 * (401 otherwise, like the real hub); a PUT body must parse with the strict
 * hubContributionV1 (an extra key → 400); a DELETE must carry an empty body
 * (400 otherwise). Every request is recorded with its answer.
 *
 * The module hub endpoints (/api/hub/modules/*, plan/phase-upgrades-u2.md
 * §6.2) are the real module-hub service over in-memory stores — the same
 * authentication, the six checks and receipts — signed with the TEST-ONLY hub
 * key (contracts/fixtures/module-hub-test-key.ts), which no real box trusts.
 * Installs registered here are known to both.
 */
import {
  TEST_ONLY_MODULE_HUB_ORIGIN,
  TEST_ONLY_MODULE_HUB_PRIVATE_KEY_PKCS8,
} from '../contracts/fixtures/module-hub-test-key'
import { HUB_ERROR_STATUS, HubError } from '../modules/contribute/hub/errors'
import { memoryHubStore } from '../modules/contribute/hub/memory-store'
import { authenticate } from '../modules/contribute/hub/service'
import {
  HUB_HEADERS,
  HUB_PATHS,
  hubContributionV1,
  hubRegisterV1,
  verifyHubRequest,
} from '../modules/contribute/share/contract'
import { memoryBundleStorage } from '../modules/module-hub/bundles'
import { hubTraceBatchV1 } from '../modules/traces/payload'
import { TRACE_PATHS } from '../modules/traces/worker'
import { lockCatalog } from '../modules/module-hub/checks'
import { MODULE_HUB_ERROR_STATUS, ModuleHubError } from '../modules/module-hub/errors'
import { memoryModuleHubStore } from '../modules/module-hub/memory-store'
import {
  fetchModuleBundle,
  publishModule,
  reportModuleRun,
  type ModuleHubDeps,
} from '../modules/module-hub/service'

export type MockHubRequest = {
  at: string
  method: string
  path: string
  installId: string | null
  body: string
  /** null: unsigned (register); otherwise whether verifyHubRequest held. */
  signatureOk: boolean | null
  status: number
  answer: Record<string, unknown>
}

const contributionPath = new RegExp(`^${HUB_PATHS.contribution('([0-9a-f-]{36})').replace(/\//g, '\\/')}$`)
const installPath = new RegExp(`^${HUB_PATHS.install('([0-9a-f-]{36})').replace(/\//g, '\\/')}$`)

/** Product signals (plan/traces-phone-home.md T4): POST /api/hub/traces, DELETE it or /api/hub/traces/:batchId. */
const tracesBatchPath = /^\/api\/hub\/traces\/([0-9a-f-]{36})$/

type Answer = { status: number; answer: Record<string, unknown>; signatureOk: boolean | null; installId: string | null }

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

type Headers = Record<string, string | string[] | undefined>

/** An answer of a module endpoint: JSON, or the bytes of a bundle. */
export type ModuleAnswer = { status: number; answer: Record<string, unknown> } | { status: number; bytes: Uint8Array }

const MODULE_PATH = /^\/api\/hub\/modules\//
const MODULE_BUNDLE_PATH = /^\/api\/hub\/modules\/bundles\/([^/]+)$/
const MODULE_RUN_PATH = /^\/api\/hub\/modules\/([^/]+)\/run$/

/** Whether a path is one of the module hub's (served by receiveModules). */
export const isModulePath = (path: string) => MODULE_PATH.test(path)

/** One mock hub's state and its request handler (pure: no sockets), so it is unit-tested. */
export function createMockHub(now: () => number = Date.now, opts: { origin?: string } = {}) {
  const installs = new Map<string, string>() // install id → public key (SPKI DER, base64)
  const contributions = new Map<string, unknown>() // `${installId}/${remoteId}` → payload
  const traceBatches = new Map<string, unknown>() // `${installId}/${batchId}` → the strict batch
  const requests: MockHubRequest[] = []
  // The module hub: the real service over memory stores; registered installs are known to it too.
  const hubStore = memoryHubStore()
  const moduleStore = memoryModuleHubStore(hubStore.installs)
  const bundles = memoryBundleStorage()
  const summaryQueue: string[] = []
  const moduleDeps: ModuleHubDeps = {
    authenticate: (req) => authenticate({ store: hubStore, now }, req),
    now,
    store: moduleStore,
    bundles,
    signingKey: () => TEST_ONLY_MODULE_HUB_PRIVATE_KEY_PKCS8,
    origin: () => opts.origin ?? TEST_ONLY_MODULE_HUB_ORIGIN,
    catalog: lockCatalog(),
    enqueueSummary: async (sha) => {
      summaryQueue.push(sha)
    },
  }

  function handle(method: string, path: string, headers: Headers, body: string): Answer {
    if (method === 'POST' && path === HUB_PATHS.register) {
      const reg = hubRegisterV1.safeParse(parseJson(body))
      if (!reg.success) return { status: 400, answer: { error: reg.error.issues[0]?.message ?? 'invalid' }, signatureOk: null, installId: null }
      const known = installs.get(reg.data.install_id)
      if (known && known !== reg.data.public_key)
        return { status: 409, answer: { error: 'another key' }, signatureOk: null, installId: reg.data.install_id }
      installs.set(reg.data.install_id, reg.data.public_key)
      if (!hubStore.installs.has(reg.data.install_id)) {
        const at = new Date(now())
        hubStore.installs.set(reg.data.install_id, {
          installId: reg.data.install_id,
          publicKey: reg.data.public_key,
          appVersion: reg.data.app_version,
          registeredAt: at,
          lastSeenAt: at,
          revokedAt: null,
        })
      }
      return { status: known ? 200 : 201, answer: { registered: true, install_id: reg.data.install_id }, signatureOk: null, installId: reg.data.install_id }
    }

    const contribution = contributionPath.exec(path)
    const install = installPath.exec(path)
    const traces = path === TRACE_PATHS.traces
    const traceBatch = tracesBatchPath.exec(path)
    if (!contribution && !install && !traces && !traceBatch) return { status: 404, answer: { error: `mock hub has no route for ${method} ${path}` }, signatureOk: null, installId: null }

    const header = (name: string) => {
      const v = headers[name]
      return Array.isArray(v) ? v[0] : v
    }
    const installId = header(HUB_HEADERS.install) ?? null
    const publicKey = installId ? installs.get(installId) : undefined
    if (!installId || !publicKey) return { status: 401, answer: { error: 'unknown install: register first' }, signatureOk: false, installId }
    const verdict = verifyHubRequest({
      method,
      path,
      body,
      headers: {
        [HUB_HEADERS.install]: installId,
        [HUB_HEADERS.timestamp]: header(HUB_HEADERS.timestamp),
        [HUB_HEADERS.signature]: header(HUB_HEADERS.signature),
      },
      publicKey,
      now: now(),
    })
    if (!verdict.ok) return { status: 401, answer: { error: `request not accepted: ${verdict.reason}` }, signatureOk: false, installId }
    const ok = (status: number, answer: Record<string, unknown>): Answer => ({ status, answer, signatureOk: true, installId })

    if (traces || traceBatch) {
      if (method === 'POST' && traces) {
        // The strict Tier A schema, the hub's own: an extra key anywhere is a 400.
        const p = hubTraceBatchV1.safeParse(parseJson(body))
        if (!p.success) return ok(400, { error: `invalid body: ${p.error.issues[0]?.path.join('.')}: ${p.error.issues[0]?.message ?? 'does not match'}` })
        const key = `${installId}/${p.data.batch_id}`
        const created = !traceBatches.has(key)
        traceBatches.set(key, p.data)
        return ok(created ? 201 : 200, { outcome: created ? 'created' : 'duplicate', spans: p.data.spans.length })
      }
      if (method === 'DELETE') {
        if (body !== '') return ok(400, { error: 'a DELETE carries no body' })
        let deleted = 0
        for (const key of [...traceBatches.keys()])
          if ((traceBatch ? key === `${installId}/${traceBatch[1]}` : key.startsWith(`${installId}/`)) && traceBatches.delete(key)) deleted++
        return ok(200, { deleted })
      }
      return ok(405, { error: `mock hub: ${method} is not allowed on ${path}` })
    }
    if (method === 'DELETE') {
      if (body !== '') return ok(400, { error: 'a DELETE carries no body' })
      if (install) {
        if (install[1] !== installId) return ok(403, { error: 'an install can only withdraw itself' })
        let deleted = 0
        for (const key of [...contributions.keys()]) if (key.startsWith(`${installId}/`) && contributions.delete(key)) deleted++
        return ok(200, { deleted })
      }
      return ok(200, { deleted: contributions.delete(`${installId}/${contribution![1]}`) })
    }
    if (method === 'PUT' && contribution) {
      const p = hubContributionV1.safeParse(parseJson(body))
      if (!p.success) return ok(400, { error: `invalid body: ${p.error.issues[0]?.message ?? 'does not match'}` })
      if (p.data.remote_id !== contribution[1]) return ok(400, { error: 'remote_id in the body is not the id in the path' })
      const key = `${installId}/${p.data.remote_id}`
      const created = !contributions.has(key)
      contributions.set(key, p.data)
      return ok(created ? 201 : 200, { outcome: created ? 'created' : 'updated' })
    }
    return ok(405, { error: `mock hub: ${method} is not allowed on ${path}` })
  }

  /** Handle and record one request. */
  function receive(method: string, path: string, headers: Headers, body: string): Answer {
    const out = handle(method, path, headers, body)
    requests.push({ at: new Date(now()).toISOString(), method, path, installId: out.installId, body, signatureOk: out.signatureOk, status: out.status, answer: out.answer })
    return out
  }

  /** Handle and record one request to a module endpoint (the real module-hub service). */
  async function receiveModules(method: string, path: string, headers: Headers, body: string): Promise<ModuleAnswer> {
    const h = new globalThis.Headers()
    for (const [k, v] of Object.entries(headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v[0]! : v)
    const req = { method, path, headers: h, body }
    let out: ModuleAnswer
    try {
      const bundle = MODULE_BUNDLE_PATH.exec(path)
      const run = MODULE_RUN_PATH.exec(path)
      if (method === 'POST' && path === '/api/hub/modules/publish') {
        const r = await publishModule(moduleDeps, req)
        out = { status: r.status, answer: r.body }
      } else if (method === 'GET' && bundle) {
        const r = await fetchModuleBundle(moduleDeps, req, bundle[1]!)
        out = { status: r.status, bytes: r.bytes }
      } else if (method === 'PUT' && run) {
        const r = await reportModuleRun(moduleDeps, req, run[1]!)
        out = { status: r.status, answer: r.body }
      } else {
        out = { status: 404, answer: { error: `mock hub has no route for ${method} ${path}` } }
      }
    } catch (err) {
      if (err instanceof HubError) out = { status: HUB_ERROR_STATUS[err.code], answer: { error: err.message, code: err.code } }
      else if (err instanceof ModuleHubError) out = { status: MODULE_HUB_ERROR_STATUS[err.code], answer: { error: err.message, code: err.code } }
      else throw err
    }
    const installId = h.get(HUB_HEADERS.install)
    requests.push({
      at: new Date(now()).toISOString(),
      method,
      path,
      installId,
      body: path === '/api/hub/modules/publish' ? `(${Buffer.byteLength(body)} bytes)` : body,
      signatureOk: out.status === 401 ? false : true,
      status: out.status,
      answer: 'answer' in out ? out.answer : { bytes: out.bytes.byteLength },
    })
    return out
  }

  return { receive, receiveModules, requests, contributions, traceBatches, hubStore, moduleStore, bundles, summaryQueue }
}

