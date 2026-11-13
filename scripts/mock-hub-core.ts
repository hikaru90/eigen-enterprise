/**
 * The mock central Contribute board's logic (scripts/mock-hub.ts serves it).
 * It speaks the hub API of modules/contribute/share/contract.ts with the
 * contract's own code — never a copy of it: register parses hubRegisterV1;
 * every other request must pass verifyHubRequest against the registered key
 * (401 otherwise, like the real hub); a PUT body must parse with the strict
 * hubContributionV1 (an extra key → 400); a DELETE must carry an empty body
 * (400 otherwise). Every request is recorded with its answer.
 */
import {
  HUB_HEADERS,
  HUB_PATHS,
  hubContributionV1,
  hubRegisterV1,
  verifyHubRequest,
} from '../modules/contribute/share/contract'

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

type Answer = { status: number; answer: Record<string, unknown>; signatureOk: boolean | null; installId: string | null }

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

type Headers = Record<string, string | string[] | undefined>

/** One mock hub's state and its request handler (pure: no sockets), so it is unit-tested. */
export function createMockHub(now: () => number = Date.now) {
  const installs = new Map<string, string>() // install id → public key (SPKI DER, base64)
  const contributions = new Map<string, unknown>() // `${installId}/${remoteId}` → payload
  const requests: MockHubRequest[] = []

  function handle(method: string, path: string, headers: Headers, body: string): Answer {
    if (method === 'POST' && path === HUB_PATHS.register) {
      const reg = hubRegisterV1.safeParse(parseJson(body))
      if (!reg.success) return { status: 400, answer: { error: reg.error.issues[0]?.message ?? 'invalid' }, signatureOk: null, installId: null }
      const known = installs.get(reg.data.install_id)
      if (known && known !== reg.data.public_key)
        return { status: 409, answer: { error: 'another key' }, signatureOk: null, installId: reg.data.install_id }
      installs.set(reg.data.install_id, reg.data.public_key)
      return { status: known ? 200 : 201, answer: { registered: true, install_id: reg.data.install_id }, signatureOk: null, installId: reg.data.install_id }
    }

    const contribution = contributionPath.exec(path)
    const install = installPath.exec(path)
    if (!contribution && !install) return { status: 404, answer: { error: `mock hub has no route for ${method} ${path}` }, signatureOk: null, installId: null }

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

  return { receive, requests, contributions }
}

