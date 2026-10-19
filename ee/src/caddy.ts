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
  /**
   * Stable loopback listeners for workloads whose slot port changes on every
   * deploy (e.g. pg_cron → eigenEnterprise). Never exposed publicly.
   */
  internal?: Array<{ port: number; workload: string }>
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

  const acme: Json = input.acmeEmail ? { module: 'acme', email: input.acmeEmail } : { module: 'acme' }
  const hosts = input.routes.map((r) => r.host)
  const local = hosts.filter(isReservedHost)
  const publicHosts = hosts.filter((h) => !isReservedHost(h))
  const policies: Json[] = []
  if (publicHosts.length > 0) policies.push({ subjects: publicHosts, issuers: [acme] })
  // Reserved TLDs can never get a public certificate: Caddy's local CA covers them (test boxes only).
  if (local.length > 0) policies.push({ subjects: local, issuers: [{ module: 'internal' }] })

  const servers: Json = { ee: { listen: [':443', ':80'], routes } }
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
    apps: {
      http: { servers },
      ...(policies.length > 0 ? { tls: { automation: { policies } } } : {}),
    },
  }
}
