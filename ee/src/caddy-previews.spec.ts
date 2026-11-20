import { describe, expect, it } from 'vitest'
import { PAUSED_PAGE, PREVIEW_STARTING_PAGE, renderCaddyConfig, type CaddyInput } from './caddy.ts'

type Route = { match: Array<{ host: string[] }>; handle: Array<Record<string, unknown>>; terminal?: boolean }
type Cfg = {
  apps: {
    http: { servers: { ee: { routes: Route[] } } }
    tls: { automation: { policies: Array<{ subjects: string[]; issuers: Array<{ module: string }> }> } }
  }
}
const render = (i: CaddyInput) => renderCaddyConfig(i) as unknown as Cfg

const base: CaddyInput = {
  routes: [{ host: 'os.example.com', workload: 'os' }],
  upstreams: { os: { kind: 'proxy', port: 3001 } },
  acmeEmail: null,
  trustedProxy: null,
}

describe('caddy: Drive app previews (plan/phase-drive-app-preview.md)', () => {
  it('no previews renders exactly what it rendered before', () => {
    expect(renderCaddyConfig({ ...base, previews: [] })).toEqual(renderCaddyConfig(base))
  })

  it('a running preview proxies its host to the port the dev server listens on, Host rewritten to localhost', () => {
    const cfg = render({ ...base, previews: [{ host: 'pv3f9a0c12be47.preview.os.example.com', upstream: { dial: '127.0.0.1:5173', port: 5173 } }] })
    const route = cfg.apps.http.servers.ee.routes.find((r) => r.match[0]?.host[0] === 'pv3f9a0c12be47.preview.os.example.com')
    expect(route).toEqual({
      match: [{ host: ['pv3f9a0c12be47.preview.os.example.com'] }],
      handle: [
        {
          handler: 'reverse_proxy',
          upstreams: [{ dial: '127.0.0.1:5173' }],
          headers: { request: { set: { Host: ['localhost:5173'] } } },
        },
      ],
      terminal: true,
    })
  })

  it('a preview still installing answers 503 with a starting page (so its certificate is issued meanwhile)', () => {
    const cfg = render({ ...base, previews: [{ host: 'pv3f9a0c12be47.preview.os.example.com', upstream: null }] })
    const route = cfg.apps.http.servers.ee.routes[1]!
    expect(route.handle[0]).toMatchObject({ handler: 'static_response', status_code: 503, body: PREVIEW_STARTING_PAGE })
  })

  it('a public console host gets ACME for its preview hosts; a .localhost/.test box the internal issuer', () => {
    const pub = render({ ...base, previews: [{ host: 'pv3f9a0c12be47.preview.os.example.com', upstream: null }] })
    expect(pub.apps.tls.automation.policies).toEqual([
      { subjects: ['os.example.com', 'pv3f9a0c12be47.preview.os.example.com'], issuers: [{ module: 'acme' }] },
    ])
    const local = render({
      ...base,
      routes: [{ host: 'os.ee.localhost', workload: 'os' }],
      previews: [{ host: 'pv3f9a0c12be47.preview.os.ee.localhost', upstream: { dial: '127.0.0.1:41000', port: 41000 } }],
    })
    expect(local.apps.tls.automation.policies).toEqual([
      { subjects: ['os.ee.localhost', 'pv3f9a0c12be47.preview.os.ee.localhost'], issuers: [{ module: 'internal' }] },
    ])
  })

  it('a suspended company pauses its previews too', () => {
    const cfg = render({ ...base, suspended: true, previews: [{ host: 'pv3f9a0c12be47.preview.os.example.com', upstream: { dial: '127.0.0.1:5173', port: 5173 } }] })
    expect(cfg.apps.http.servers.ee.routes[1]!.handle[0]).toMatchObject({ handler: 'static_response', status_code: 503, body: PAUSED_PAGE })
  })
})
