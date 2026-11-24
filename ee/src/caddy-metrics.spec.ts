import { describe, expect, it } from 'vitest'
import { renderCaddyConfig } from './caddy.ts'

describe('the edge counts its answers (the upgrade watch reads the 5xx rate)', () => {
  it('turns on HTTP metrics without per-host labels', () => {
    const cfg = renderCaddyConfig({
      routes: [{ host: 'os.example.com', workload: 'os' }],
      upstreams: { os: { kind: 'proxy', port: 4100 } },
      acmeEmail: null,
      trustedProxy: null,
    }) as { apps: { http: { metrics?: unknown } } }
    expect(cfg.apps.http.metrics).toEqual({})
  })
})
