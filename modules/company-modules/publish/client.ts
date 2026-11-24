import { sha256Hex } from '../../../contracts/module-bundle'
import { manifestSha256 } from '../../../contracts/module-manifest'
import { hubPublishAnswer, hubRefusalAnswer, hubRunAnswer, hubModulePublishV1, hubModuleRunV1, MODULE_HUB_PATHS } from '../../../src/lib/module-hub/contract'
import {
  HUB_NOT_CONFIGURED_SENTENCE,
  HUB_UNAVAILABLE_SENTENCE,
  PublishPortError,
  type PublishPort,
} from './port'

/**
 * The box's PublishPort over the signed module-hub API (plan/phase-upgrades-u2.md
 * §6.2). The install identity is the Contribute install key (one random id
 * and Ed25519 key per install, sealed on the server), handed in as a signer
 * by the composition (src/lib/server/module-hub/publish-port.ts), so this
 * module imports no other. A 401 means the hub does
 * not know this install (yet): it registers once through /api/hub/register
 * and sends the request again, newly signed. Any other failure is answered at
 * once — no retry loop (the caller decides):
 *   no answer, 5xx, 429 → hub_unavailable · 403 → hub_revoked ·
 *   404 (bundle) → hub_not_found · 400/409/413/422 → hub_refused with the
 *   hub's problems.
 */

export type HubCall = { method: 'GET' | 'POST' | 'PUT'; path: string; body: string; headers: Record<string, string> }
export type HubAnswer = { status: number; body: Uint8Array }
/** Throws on a network failure (no answer). */
export type ModuleHubTransport = (req: HubCall) => Promise<HubAnswer>

/** The install's identity towards the hubs: it signs requests and makes its register request. */
export type HubSigner = {
  installId: string
  /** The signature headers of one request (v1\nMETHOD\npath\nts\nsha256(body)). */
  sign: (input: { method: string; path: string; body: string; now: number }) => Record<string, string>
  /** The unsigned register body (the install id, its public key and the app version). */
  registerBody: (appVersion: string) => string
}

export type HubPublishClientDeps = {
  /** MODULE_HUB_URL: no default — unset is "module hub not configured". */
  hubUrl: () => string | undefined
  /** The install's signer (its key made and stored on first use). */
  identity: () => Promise<HubSigner>
  transport: (origin: string) => ModuleHubTransport
  appVersion: string
  /** The box's CORE_API_VERSION. */
  coreApi: string
  now: () => Date
}

export const MODULE_HUB_TIMEOUT_MS = 60_000

export function fetchModuleHubTransport(origin: string, fetchFn: typeof fetch = fetch): ModuleHubTransport {
  return async (req) => {
    const res = await fetchFn(`${origin}${req.path}`, {
      method: req.method,
      headers: { ...req.headers, ...(req.body ? { 'content-type': 'application/json' } : {}) },
      body: req.body || undefined,
      signal: AbortSignal.timeout(MODULE_HUB_TIMEOUT_MS),
      redirect: 'error',
    })
    return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) }
  }
}

function origin(value: string | undefined): string {
  const raw = value?.trim()
  if (!raw) throw new PublishPortError('hub_unavailable', HUB_NOT_CONFIGURED_SENTENCE, { reason: 'not_configured' })
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error(`MODULE_HUB_URL is not a URL: ${JSON.stringify(raw)}`)
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`MODULE_HUB_URL must be http(s), got ${u.protocol}`)
  return u.origin
}

const text = (a: HubAnswer) => new TextDecoder().decode(a.body)

function json(a: HubAnswer): unknown {
  try {
    return JSON.parse(text(a))
  } catch {
    return null
  }
}

/** The hub's own words, bounded. */
function hubSaid(a: HubAnswer): string {
  const body = json(a)
  const said = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : text(a).trim()
  return `The module hub answered HTTP ${a.status}${said ? `: ${said.slice(0, 300)}` : ''}`
}

function failure(a: HubAnswer): PublishPortError {
  if (a.status === 429 || a.status >= 500) {
    return new PublishPortError('hub_unavailable', `${HUB_UNAVAILABLE_SENTENCE} ${hubSaid(a)}`, { status: a.status, reason: 'busy' })
  }
  if (a.status === 403) return new PublishPortError('hub_revoked', `The module hub refuses this install, so its modules can't be published. ${hubSaid(a)}`, { status: 403 })
  if (a.status === 404) return new PublishPortError('hub_not_found', hubSaid(a), { status: 404 })
  const refusal = hubRefusalAnswer.safeParse(json(a))
  if (refusal.success) {
    const list = refusal.data.problems.map((p) => `${p.check}${p.path ? ` ${p.path}${p.line ? `:${p.line}` : ''}` : ''}: ${p.message}`).join('; ')
    return new PublishPortError('hub_refused', `The module hub refused it (HTTP ${a.status}): ${list}`, { status: a.status, problems: refusal.data.problems })
  }
  return new PublishPortError('hub_refused', hubSaid(a), { status: a.status })
}

export function createHubPublishPort(deps: HubPublishClientDeps): PublishPort {
  async function send(hub: ModuleHubTransport, req: HubCall): Promise<HubAnswer> {
    try {
      return await hub(req)
    } catch (err) {
      throw new PublishPortError('hub_unavailable', `${HUB_UNAVAILABLE_SENTENCE} (${err instanceof Error ? err.message : String(err)})`, { reason: 'unreachable' })
    }
  }

  async function register(hub: ModuleHubTransport, key: HubSigner): Promise<void> {
    const res = await send(hub, { method: 'POST', path: MODULE_HUB_PATHS.register, body: key.registerBody(deps.appVersion), headers: {} })
    if (res.status === 200 || res.status === 201) return
    if (res.status === 409) throw new PublishPortError('hub_revoked', `The module hub knows this install id under another key, so it refuses this install. ${hubSaid(res)}`, { status: 409 })
    throw failure(res)
  }

  /** One signed call; on a 401, register and send it once more (a new signature, never a replay). */
  async function call(method: HubCall['method'], path: string, body: string): Promise<HubAnswer> {
    const hub = deps.transport(origin(deps.hubUrl()))
    const key = await deps.identity()
    const signed = (): HubCall => ({
      method,
      path,
      body,
      headers: key.sign({ method, path, body, now: deps.now().getTime() }),
    })
    const first = await send(hub, signed())
    if (first.status !== 401) return first
    await register(hub, key)
    const again = await send(hub, signed())
    if (again.status === 401) throw new PublishPortError('hub_refused', `The module hub does not accept this install's signature. ${hubSaid(again)}`, { status: 401 })
    return again
  }

  return {
    async publish(req) {
      const body = JSON.stringify(
        hubModulePublishV1.parse({
          v: 1,
          module_id: req.moduleId,
          version: req.version,
          commit: req.commit,
          bundle_sha256: req.bundleSha256,
          manifest: req.manifest,
          bundle_b64: Buffer.from(req.bundle).toString('base64'),
          core_api: deps.coreApi,
          app_version: deps.appVersion,
        }),
      )
      const res = await call('POST', MODULE_HUB_PATHS.publish, body)
      if (res.status !== 200 && res.status !== 201) throw failure(res)
      const answer = hubPublishAnswer.safeParse(json(res))
      if (!answer.success) throw new PublishPortError('hub_refused', `The module hub's receipt is not a receipt: ${answer.error.issues[0]?.message ?? 'invalid'}`, { status: res.status })
      const r = answer.data.receipt
      const expected = { moduleId: req.moduleId, version: req.version, commit: req.commit, bundleSha256: req.bundleSha256, manifestSha256: manifestSha256(req.manifest) }
      const off = (Object.keys(expected) as (keyof typeof expected)[]).filter((k) => r[k] !== expected[k])
      if (off.length) throw new PublishPortError('hub_refused', `The module hub's receipt does not match what was published (${off.join(', ')})`, { status: res.status })
      return { receipt: r, created: res.status === 201 }
    },

    async reportRun(report) {
      const body = JSON.stringify(hubModuleRunV1.parse({ v: 1, bundle_sha256: report.bundleSha256, state: report.state }))
      const res = await call('PUT', MODULE_HUB_PATHS.run(report.moduleId), body)
      if (res.status !== 200) throw failure(res)
      const answer = hubRunAnswer.safeParse(json(res))
      if (!answer.success) throw new PublishPortError('hub_refused', `The module hub's run answer is not one: ${answer.error.issues[0]?.message ?? 'invalid'}`, { status: 200 })
      return answer.data
    },

    async fetchBundle(bundleSha256) {
      const res = await call('GET', MODULE_HUB_PATHS.bundle(bundleSha256), '')
      if (res.status !== 200) throw failure(res)
      const actual = sha256Hex(res.body)
      if (actual !== bundleSha256) throw new PublishPortError('hub_refused', `The module hub sent bundle bytes with sha256 ${actual}, not ${bundleSha256}`, { status: 200 })
      return res.body
    },
  }
}
