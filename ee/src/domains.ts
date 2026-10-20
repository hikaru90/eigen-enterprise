import type { DesiredState } from './company-repo.ts'
import type { Route } from './spec.ts'

/**
 * Domains (§3.7, D10). eigenEnterprise (`os`) has two kinds of host:
 * - the console host: the whole app (operator surface, auth, agent); drives ORIGIN.
 * - the public host: ONLY the public website surface; everything else 404s at the edge.
 * Any other workload gets plain app hosts.
 */

type State = Omit<DesiredState, 'rev'>

/** The paths eigenEnterprise serves on its public host: website pages, their assets, the contact form. */
export const OS_PUBLIC_SURFACE = [
  '/s',
  '/s/*',
  '/_app/*',
  '/api/website/contact',
  '/api/website/contact/*',
  '/favicon.ico',
  '/favicon.png',
  '/favicon.svg',
  '/favicon-transparent.png',
  '/apple-touch-icon.png',
  '/apple-touch-icon-dark.png',
  '/robots.txt',
]

export const OS_HOME_PATH = '/s/home'

function withoutHost(routes: Route[], host: string): Route[] {
  return routes.filter((r) => r.host !== host)
}

export function setConsoleHost(s: State, host: string): State {
  const os = s.workloads.find((w) => w.name === 'os')
  if (!os) throw new Error('no os workload — the console host belongs to eigenEnterprise')
  if (s.settings.publicHost === host) throw new Error(`${host} is the public website host; pick another console host`)
  const routes = withoutHost(withoutHost(s.routes, s.settings.consoleHost), host)
  routes.push({ host, workload: 'os' })
  return {
    workloads: s.workloads.map((w) => (w.name === 'os' ? { ...w, env: { ...w.env, ORIGIN: `https://${host}` } } : w)),
    routes,
    settings: { ...s.settings, consoleHost: host },
  }
}

export function addDomain(s: State, i: { host: string; workload: string; role: 'console' | 'public' | 'app' }): State {
  if (i.role === 'console') {
    if (i.workload !== 'os') throw new Error('only eigenEnterprise (os) has a console host')
    return setConsoleHost(s, i.host)
  }
  if (i.host === s.settings.consoleHost) throw new Error(`${i.host} is the console host`)
  const target = s.workloads.find((w) => w.name === i.workload)
  if (!target) throw new Error(`no workload ${i.workload}`)
  if (i.role === 'public') {
    if (i.workload !== 'os') throw new Error('the public website host belongs to eigenEnterprise (os)')
    const routes = withoutHost(s.settings.publicHost ? withoutHost(s.routes, s.settings.publicHost) : s.routes, i.host)
    routes.push({ host: i.host, workload: 'os', allowPaths: OS_PUBLIC_SURFACE, rootRewrite: OS_HOME_PATH })
    return { ...s, routes, settings: { ...s.settings, publicHost: i.host } }
  }
  if (target.tier === 'system') throw new Error(`${i.workload} is a system workload; give it a console or public host`)
  const routes = withoutHost(s.routes, i.host)
  routes.push({ host: i.host, workload: i.workload })
  return { ...s, routes }
}

export function removeDomain(s: State, host: string): State {
  if (host === s.settings.consoleHost) throw new Error('the console host cannot be removed; set another one first')
  if (!s.routes.some((r) => r.host === host)) throw new Error(`no domain ${host}`)
  return {
    ...s,
    routes: withoutHost(s.routes, host),
    settings: s.settings.publicHost === host ? { ...s.settings, publicHost: null } : s.settings,
  }
}
