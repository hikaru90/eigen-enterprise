import type { Route } from './spec.ts'
import { PATHS } from './paths.ts'

/**
 * Render the COMPLETE Caddy config from desired state (D10). ee never edits
 * Caddy incrementally: it loads this whole document, Caddy validates it, and
 * an invalid config is rejected while the old one keeps serving.
 */

export type Upstream = { kind: 'proxy'; port: number } | { kind: 'static'; root: string }

export type CaddyInput = {
  routes: Route[]
  /** Live upstream per workload name (the active slot's port, or a static root). */
  upstreams: Record<string, Upstream>
  /** ACME account email; null = Caddy's default (no email). */
  acmeEmail: string | null
  /** The router's IPv4 CIDR when the box sits behind one speaking PROXY protocol (settings.trustedProxy); null = direct. */
  trustedProxy: string | null
  /**
   * Stable loopback listeners for workloads whose slot port changes on every
   * deploy (e.g. pg_cron → eigenEnterprise). Never exposed publicly.
   */
  internal?: Array<{ port: number; workload: string }>
  /** Managed box paused by the control plane: every public route answers PAUSED_PAGE (503). */
  suspended?: boolean
  /** Active Drive app previews (previews.ts): in ee's memory only, never in the company repo. */
  previews?: PreviewRoute[]
}

/**
 * One preview host. upstream null: installing or starting (Caddy answers
 * PREVIEW_STARTING_PAGE and already gets the host's certificate); set: running.
 */
export type PreviewRoute = { host: string; upstream: { dial: string; port: number } | null }

/** What a preview host shows until its dev server listens. */
export const PREVIEW_STARTING_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Starting</title></head>' +
  '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1rem;color:#333"><h1 style="font-size:1.4rem">This app is starting</h1>' +
  '<p>Its dependencies are installing. Reload in a moment.</p></body></html>'

/** What every public host shows while a managed company is suspended (plan/phase-managed-box.md D5). */
export const PAUSED_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Paused</title></head>' +
  '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1rem;color:#333"><h1 style="font-size:1.4rem">This company is paused</h1>' +
  '<p>Its data is safe. It will be back as soon as it is resumed.</p></body></html>'

const pausedHandler: Json = {
  handler: 'static_response',
  status_code: 503,
  headers: { 'Content-Type': ['text/html; charset=utf-8'], 'Retry-After': ['3600'] },
  body: PAUSED_PAGE,
}

type Json = Record<string, unknown>

/** RFC 2606 / 6761 names that no public CA will ever issue for. */
export function isReservedHost(host: string): boolean {
  return /\.(test|localhost|invalid|example)$/.test(host)
}

function handlerFor(up: Upstream): Json {
  if (up.kind === 'proxy') {
    return { handler: 'reverse_proxy', upstreams: [{ dial: `127.0.0.1:${up.port}` }] }
  }
  return { handler: 'file_server', root: up.root }
}

export function renderCaddyConfig(input: CaddyInput): Json {
  const routes: Json[] = []
  for (const r of input.routes) {
    const up = input.upstreams[r.workload]
    if (!up) throw new Error(`route ${r.host} → ${r.workload}: workload has no live upstream`)
    if (input.suspended) {
      routes.push({ match: [{ host: [r.host] }], handle: [pausedHandler], terminal: true })
      continue
    }
    const subroutes: Json[] = []
    if (r.rootRewrite) {
      subroutes.push({ match: [{ path: ['/'] }], handle: [{ handler: 'rewrite', uri: r.rootRewrite }] })
    }
    if (r.allowPaths) {
      const allowed = r.rootRewrite ? ['/', ...r.allowPaths] : r.allowPaths
      subroutes.push({
        match: [{ not: [{ path: allowed }] }],
        handle: [{ handler: 'static_response', status_code: 404 }],
        terminal: true,
      })
    }
    subroutes.push({ handle: [handlerFor(up)] })
    routes.push({
      match: [{ host: [r.host] }],
      handle: [{ handler: 'subroute', routes: subroutes }],
      terminal: true,
    })
  }

  for (const p of input.previews ?? []) {
    let handler: Json
    if (input.suspended) handler = pausedHandler
    else if (p.upstream === null) {
      handler = { handler: 'static_response', status_code: 503, headers: { 'Content-Type': ['text/html; charset=utf-8'], 'Retry-After': ['5'] }, body: PREVIEW_STARTING_PAGE }
    } else {
      // Dev servers check Host (Vite allowedHosts): they see localhost. Websockets (hot reload) pass through reverse_proxy.
      handler = { handler: 'reverse_proxy', upstreams: [{ dial: p.upstream.dial }], headers: { request: { set: { Host: [`localhost:${p.upstream.port}`] } } } }
    }
    routes.push({ match: [{ host: [p.host] }], handle: [handler], terminal: true })
  }

  const acme: Json = input.acmeEmail ? { module: 'acme', email: input.acmeEmail } : { module: 'acme' }
  const hosts = [...input.routes.map((r) => r.host), ...(input.previews ?? []).map((p) => p.host)]
  const local = hosts.filter(isReservedHost)
  const publicHosts = hosts.filter((h) => !isReservedHost(h))
  const policies: Json[] = []
  if (publicHosts.length > 0) policies.push({ subjects: publicHosts, issuers: [acme] })
  // Reserved TLDs can never get a public certificate: Caddy's local CA covers them (test boxes only).
  if (local.length > 0) policies.push({ subjects: local, issuers: [{ module: 'internal' }] })

  const publicServer: Json = { listen: [':443', ':80'], routes }
  if (input.trustedProxy) {
    // Behind a shared-IP router (SNI passthrough + PROXY v2): the real client
    // address comes from the PROXY header, accepted only from the router.
    publicServer.listener_wrappers = [
      { wrapper: 'proxy_protocol', allow: [input.trustedProxy], timeout: '5s' },
      { wrapper: 'tls' },
    ]
  }
  const servers: Json = { ee: publicServer }
  for (const i of input.internal ?? []) {
    const up = input.upstreams[i.workload]
    if (!up) continue
    servers[`internal-${i.workload}`] = {
      listen: [`127.0.0.1:${i.port}`],
      routes: [{ handle: [handlerFor(up)] }],
      automatic_https: { disable: true },
    }
  }

  return {
    admin: { listen: `unix/${PATHS.caddyAdminSocket}` },
    // Pinned (the package default) so certificates.ts reads where Caddy writes.
    storage: { module: 'file_system', root: PATHS.caddyStorage },
    apps: {
      // HTTP metrics (Caddy ≥ 2.8 makes them opt-in) on the admin socket's /metrics: the upgrade
      // watch reads the app's 5xx rate from them (upgrade-watch.ts). Counts only, no hosts or paths.
      http: { servers, metrics: {} },
      ...(policies.length > 0 ? { tls: { automation: { policies } } } : {}),
    },
  }
}
