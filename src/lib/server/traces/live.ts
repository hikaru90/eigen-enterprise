import type { TracesDeps } from '../../../../modules/traces/service'
import type { TraceHub, TraceTickResult } from '../../../../modules/traces/worker'
import { randomUUID } from 'node:crypto'
import { APP_VERSION } from '$lib/app-version'

/**
 * Live wiring of the traces phone-home (plan/traces-phone-home.md §3), the composition root
 * between two modules: the install's identity, registration and hub transport are Contribute's
 * (one signed identity per install, CONTRIBUTE_HUB_URL, no default); the store, the exporter and
 * the Jev gate are Traces'. The central hub itself sends nothing.
 */

async function hub(): Promise<TraceHub> {
  const { shareDeps } = await import('../../../../modules/contribute/share/live')
  const { ensureRegistered, installKey } = await import('../../../../modules/contribute/share/worker')
  const { signedRequest } = await import('../../../../modules/contribute/share/hub')
  const d = await shareDeps()
  return {
    config: () => {
      const c = d.hub()
      return c.ok ? { ok: true } : { ok: false, message: c.message }
    },
    async ready() {
      const settings = await d.share.settings()
      if (settings.revokedAt) return { ok: false, revoked: true, message: settings.lastError ?? 'The makers’ hub refused this install.' }
      const c = d.hub()
      if (!c.ok) return { ok: false, revoked: false, message: c.message }
      const key = await ensureRegistered(d, settings, d.transport(c.url))
      if (key) return { ok: true }
      const after = await d.share.settings()
      return { ok: false, revoked: after.revokedAt !== null, message: after.lastError ?? 'Registering this install with the makers’ hub failed.' }
    },
    async send(req) {
      const c = d.hub()
      if (!c.ok) throw new Error(c.message)
      const key = await installKey(d, await d.share.settings())
      return d.transport(c.url)(signedRequest(key, req.method, req.path, req.body, d.now()))
    },
    async unauthorized() {
      await d.share.setRegistered(null, d.now())
    },
  }
}

async function db() {
  const { appSql, createScopedDrizzle } = await import('$lib/server/db')
  return createScopedDrizzle(appSql)
}

let depsPromise: Promise<TracesDeps> | null = null

export function liveTracesDeps(): Promise<TracesDeps> {
  depsPromise ??= (async (): Promise<TracesDeps> => {
    const { dbTraceStore } = await import('../../../../modules/traces/db-store')
    return { store: dbTraceStore(await db()), hub: await hub(), now: () => new Date() }
  })().catch((err) => {
    depsPromise = null
    throw err
  })
  return depsPromise
}

/** One Jev decision on an open value, on the company's provider, billed to the owner. */
async function decideValue(v: { field: 'tool' | 'model'; value: string }) {
  const { decide } = await import('$lib/server/decisions/decide')
  const { tracesTraceValue } = await import('../../../../modules/traces/decision-kinds')
  const { companyOwnerId, onCompanyProvider } = await import('$lib/server/llm/company-provider')
  const { withDbUser } = await import('$lib/server/db')
  const owner = await companyOwnerId()
  if (!owner) throw new Error('The company has no owner yet, so open trace values cannot be classified.')
  const r = await withDbUser(owner, () => onCompanyProvider(() => decide(tracesTraceValue, v, { requestedBy: owner, judge: { none: true } })))
  if (r.outcome !== 'decided') throw new Error(`traces.trace_value was not decided (${r.outcome})`)
  return r.choice
}

/**
 * One exporter pass for the job-queue tick; one at a time per process. `now` is the tick's clock:
 * only the dev/e2e harness passes one (to skip the settle and build waits), the ticker never does.
 */
let running: Promise<TraceTickResult | null> | null = null
export function tracesTick(now?: () => Date): Promise<TraceTickResult | null> {
  running ??= (async () => {
    const { isHubInstall } = await import('../../../../modules/contribute/share/live')
    if (await isHubInstall()) return null
    const { runTraceTick } = await import('../../../../modules/traces/worker')
    const { dbTraceSourceReader } = await import('../../../../modules/traces/db-store')
    const { upgradeTraceRows } = await import('./upgrades')
    const deps = await liveTracesDeps()
    const out = await runTraceTick({
      ...deps,
      read: dbTraceSourceReader(await db(), upgradeTraceRows),
      decide: decideValue,
      appVersion: APP_VERSION,
      eeVersion: null,
      newId: randomUUID,
      ...(now ? { now } : {}),
    })
    if (out.built > 0 || out.sent > 0 || out.failed > 0) console.info('[traces] tick', out)
    return out
  })().finally(() => {
    running = null
  })
  return running
}

/** The makers' hub (trace-hub active): roll up finished days and drop expired / revoked spans, at most hourly. */
let lastRetention = 0
export async function traceHubRetentionTick(now = Date.now()): Promise<void> {
  if (now - lastRetention < 60 * 60_000) return
  const { traceHubActive, traceHubReadDeps } = await import('../../../../modules/traces/hub/live')
  if (!(await traceHubActive())) return
  lastRetention = now
  const { runRetention } = await import('../../../../modules/traces/hub/service')
  const out = await runRetention(await traceHubReadDeps())
  if (out.rolledUp + out.expired + out.revoked > 0) console.info('[trace-hub] retention', out)
}
