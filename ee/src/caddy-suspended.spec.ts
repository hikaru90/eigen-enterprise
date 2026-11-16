import { describe, expect, it } from 'vitest'
import { PAUSED_PAGE, renderCaddyConfig } from './caddy.ts'

type J = Record<string, any>
const input = {
  routes: [
    { host: 'os.example.com', workload: 'os' },
    { host: 'www.example.com', workload: 'site' },
  ] as any,
  upstreams: { os: { kind: 'proxy', port: 3001 }, site: { kind: 'static', root: '/srv/site' } } as any,
  acmeEmail: null,
  trustedProxy: null,
  internal: [{ port: 4000, workload: 'os' }],
}

describe('caddy: suspended (managed box paused by the control plane, D5)', () => {
  it('answers every public host with a 503 paused page; loopback servers and TLS unchanged', () => {
    const normal = renderCaddyConfig(input) as J
    const paused = renderCaddyConfig({ ...input, suspended: true }) as J
    const routes = paused.apps.http.servers.ee.routes as J[]
    expect(routes.map((r) => r.match[0].host[0])).toEqual(['os.example.com', 'www.example.com'])
    for (const r of routes) {
      expect(r.handle).toEqual([
        { handler: 'static_response', status_code: 503, headers: { 'Content-Type': ['text/html; charset=utf-8'], 'Retry-After': ['3600'] }, body: PAUSED_PAGE },
      ])
    }
    expect(paused.apps.http.servers['internal-os']).toEqual(normal.apps.http.servers['internal-os'])
    expect(paused.apps.tls).toEqual(normal.apps.tls)
    expect(PAUSED_PAGE).toContain('This company is paused')
  })

  it('suspended false (the default) renders the normal routes', () => {
    expect(renderCaddyConfig({ ...input, suspended: false })).toEqual(renderCaddyConfig(input))
  })
})
