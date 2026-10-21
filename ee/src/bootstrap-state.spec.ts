import { describe, expect, it } from 'vitest'
import { bootstrapRouting } from './bootstrap.ts'

const sslip = '152-53-118-209.sslip.io'
const prior = {
  routes: [{ host: sslip, workload: 'os' }, { host: 'cerberusblue.com', workload: 'site' }],
  settings: { consoleHost: sslip, publicHost: null, acmeEmail: null },
  origin: `https://${sslip}`,
}

describe('bootstrapRouting: what a (re-)run saves for the console', () => {
  it('a plain re-run keeps the console host, routes, ORIGIN and acme email', () => {
    expect(bootstrapRouting(prior, { consoleHost: sslip })).toEqual({ routes: prior.routes, settings: prior.settings, origin: prior.origin })
  })

  it('an explicit --console-host on a re-run moves the console there (route, settings, ORIGIN); the old host keeps working', () => {
    const r = bootstrapRouting(prior, { consoleHost: 'os.cerberusblue.com', explicitHost: true, acmeEmail: 'a@cerberusblue.com' })
    expect(r.settings).toEqual({ consoleHost: 'os.cerberusblue.com', publicHost: null, acmeEmail: 'a@cerberusblue.com' })
    expect(r.origin).toBe('https://os.cerberusblue.com')
    expect(r.routes).toEqual([...prior.routes, { host: 'os.cerberusblue.com', workload: 'os' }])
  })

  it('an explicit --acme-email alone is applied', () => {
    expect(bootstrapRouting(prior, { consoleHost: sslip, acmeEmail: 'a@b.co' }).settings.acmeEmail).toBe('a@b.co')
  })

  it('first run: the console host, its route and ORIGIN', () => {
    expect(bootstrapRouting(null, { consoleHost: sslip })).toEqual({
      routes: [{ host: sslip, workload: 'os' }],
      settings: { consoleHost: sslip, publicHost: null, acmeEmail: null },
      origin: `https://${sslip}`,
    })
  })
})
