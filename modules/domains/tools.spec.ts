import type { DomainsList, MailDomain } from './view'
import { describe, expect, it } from 'vitest'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { SubstrateUnavailableError, type EeStatus } from '$lib/server/ee/client'
import { cachedResolver, type DnsResolver } from './dns'
import { createDomainsTools, type DomainsEe } from './tools'

const human: ToolContext = {
  principal: { id: 'owner-1', kind: 'human', roles: ['admin'] },
  requestId: 'r1',
}
const agent: ToolContext = {
  principal: { id: 'orchestrator', kind: 'agent', roles: ['admin', 'agent'] },
  requestId: 'r2',
}

const BOX = '159.195.209.90'

class Ee implements DomainsEe {
  calls: Array<{ verb: string; input: unknown }> = []
  unavailable = false
  status_: EeStatus = {
    appliedRev: 'x',
    desiredRev: 'x',
    lastReconcileError: null,
    settings: {
      consoleHost: 'one.eigenenterprise.app',
      publicHost: null,
      acmeEmail: null,
      callsHost: 'rtc.one.eigenenterprise.app',
      rtcNodeIp: BOX,
    } as EeStatus['settings'],
    routes: [
      { host: 'one.eigenenterprise.app', workload: 'os' },
      { host: 'rtc.one.eigenenterprise.app', workload: 'livekit' },
      { host: 'eigenenterprise.app', workload: 'eigen-enterprise-website' },
    ],
    certificates: [
      {
        host: 'eigenenterprise.app',
        state: 'failing',
        lastError: 'NXDOMAIN',
        nextRetryAt: '2026-11-22T10:00:00Z',
        notAfter: null,
      },
    ],
    claims: [
      {
        host: 'eigenenterprise.app',
        verified: true,
        txtName: '_ee-verify.eigenenterprise.app',
        txtValue: 'tok-1',
      },
    ],
    workloads: [],
    events: [],
  }
  async status() {
    if (this.unavailable) throw new SubstrateUnavailableError('ENOENT')
    return this.status_
  }
  async addDomain(i: Parameters<DomainsEe['addDomain']>[0]) {
    this.calls.push({ verb: 'addDomain', input: i })
    return { rev: 'r', reconcileError: null, replaced: 'eigen-enterprise-website' }
  }
  async removeDomain(i: { host: string; author: string }) {
    this.calls.push({ verb: 'removeDomain', input: i })
    return { rev: 'r', reconcileError: null }
  }
  async retryCertificate(host: string, author: string) {
    this.calls.push({ verb: 'retryCertificate', input: { host, author } })
    return { host, reloaded: true as const }
  }
}

/** DNS in memory: A answers per name; everything else has no records. */
function fakeDns(a: Record<string, string[]>) {
  const lookups: string[] = []
  const none = () => Promise.reject(Object.assign(new Error('nodata'), { code: 'ENODATA' }))
  const r: DnsResolver = {
    resolve4: async (n) => {
      lookups.push(`A ${n}`)
      return a[n] ?? none()
    },
    resolve6: none,
    resolveCname: none,
    resolveTxt: async (n) => {
      lookups.push(`TXT ${n}`)
      return n === '_ee-verify.eigenenterprise.app' ? [['tok-1']] : none()
    },
    resolveMx: async (n) => {
      lookups.push(`MX ${n}`)
      return n === 'eigenenterprise.app'
        ? [{ exchange: 'inbound-smtp.eu-central-1.amazonaws.com', priority: 10 }]
        : none()
    },
  }
  return { r, lookups }
}

const mail: MailDomain[] = [
  {
    name: 'eigenenterprise.app',
    sendable: true,
    receiving: true,
    records: [
      {
        purpose: 'inbound_mx',
        type: 'MX',
        name: 'eigenenterprise.app',
        value: 'inbound-smtp.eu-central-1.amazonaws.com',
        priority: 10,
      },
      {
        purpose: 'dkim',
        type: 'TXT',
        name: 'ee._domainkey.eigenenterprise.app',
        value: null,
        priority: null,
      },
    ],
  },
]

function tools(
  o: { ee?: Ee; mail?: MailDomain[]; bought?: string[]; dns?: Record<string, string[]> } = {},
) {
  const ee = o.ee ?? new Ee()
  const dns = fakeDns(
    o.dns ?? {
      'eigenenterprise.app': [BOX],
      'one.eigenenterprise.app': [BOX],
      'rtc.one.eigenenterprise.app': ['1.1.1.1'],
    },
  )
  let t = 0
  const resolver = cachedResolver(dns.r, 60_000, () => t)
  const list = createDomainsTools({
    ee,
    mail: async () => o.mail ?? mail,
    bought: async () => o.bought ?? ['eigenenterprise.app', 'kindred.digital'],
    resolver,
  })
  const by = new Map(list.map((d) => [d.name, d] as [string, ToolDescriptor]))
  return { ee, dns, by, tick: (ms: number) => (t += ms) }
}

describe('domains.list: domain → hostnames → what each shows → records → certificate', () => {
  it('groups hosts under their registrable domain, apex first, bought ones marked', async () => {
    const { by } = tools()
    const out = (await by.get('domains.list')!.handler(agent, {})) as DomainsList
    expect(out.managed).toBe(true)
    expect(out.domains.map((d) => [d.name, d.source, d.hosts.map((h) => h.host)])).toEqual([
      [
        'eigenenterprise.app',
        'bought',
        ['eigenenterprise.app', 'one.eigenenterprise.app', 'rtc.one.eigenenterprise.app'],
      ],
      ['kindred.digital', 'bought', []],
    ])
  })

  it('each host: what it shows, email, records with what DNS says, claim, certificate', async () => {
    const { by } = tools()
    const out = (await by.get('domains.list')!.handler(agent, {})) as DomainsList
    const [apex, consoleHost, calls] = out.domains[0]!.hosts
    expect(apex).toMatchObject({
      shows: { kind: 'app', app: 'eigen-enterprise-website' },
      email: { sending: true, receiving: true },
      claim: { verified: true },
      certificate: { state: 'failing', lastError: 'NXDOMAIN' },
    })
    expect(apex!.records.map((r) => [r.purpose, r.type, r.name, r.value, r.status])).toEqual([
      ['web', 'A', 'eigenenterprise.app', BOX, 'ok'],
      ['claim', 'TXT', '_ee-verify.eigenenterprise.app', 'tok-1', 'ok'],
      [
        'mail_inbound_mx',
        'MX',
        'eigenenterprise.app',
        'inbound-smtp.eu-central-1.amazonaws.com',
        'ok',
      ],
    ])
    expect(consoleHost).toMatchObject({
      shows: { kind: 'console' },
      email: null,
      claim: null,
      certificate: null,
    })
    expect(calls!.shows).toEqual({ kind: 'calls' })
    expect(calls!.records).toEqual([
      expect.objectContaining({
        purpose: 'calls',
        type: 'A',
        value: BOX,
        status: 'wrong',
        observed: ['1.1.1.1'],
      }),
    ])
  })

  it('no public address on record: loud, no record invented', async () => {
    const ee = new Ee()
    ee.status_ = {
      ...ee.status_,
      settings: { ...ee.status_.settings, rtcNodeIp: null } as EeStatus['settings'],
    }
    const { by } = tools({ ee })
    await expect(by.get('domains.list')!.handler(agent, {})).rejects.toMatchObject({
      code: 'not_configured',
    })
  })

  it('not under ee: managed:false, mail domains still listed (nothing shown, mail records only)', async () => {
    const ee = new Ee()
    ee.unavailable = true
    const { by } = tools({ ee, bought: [] })
    const out = (await by.get('domains.list')!.handler(agent, {})) as DomainsList
    expect(out).toMatchObject({
      managed: false,
      reason: expect.stringMatching(/not running under ee/),
    })
    expect(out.domains[0]!.hosts).toEqual([
      expect.objectContaining({
        host: 'eigenenterprise.app',
        shows: { kind: 'nothing' },
        certificate: null,
      }),
    ])
    expect(out.domains[0]!.hosts[0]!.records.map((r) => r.purpose)).toEqual(['mail_inbound_mx'])
  })
})

describe('domains.recheck', () => {
  it('forgets the host’s cached answers and looks again', async () => {
    const { by, dns } = tools()
    await by.get('domains.list')!.handler(agent, {})
    const before = dns.lookups.length
    await by.get('domains.list')!.handler(agent, {})
    expect(dns.lookups.length).toBe(before) // cached
    const out = (await by
      .get('domains.recheck')!
      .handler(agent, { host: 'eigenenterprise.app' })) as { host: { host: string } }
    expect(out.host.host).toBe('eigenenterprise.app')
    expect(dns.lookups.slice(before)).toEqual([
      'A eigenenterprise.app',
      'TXT _ee-verify.eigenenterprise.app',
      'MX eigenenterprise.app',
    ])
  })

  it('a host the company does not use: plain words', async () => {
    const { by } = tools()
    await expect(
      by.get('domains.recheck')!.handler(agent, { host: 'other.example.com' }),
    ).rejects.toThrow("other.example.com is not one of this company's hostnames.")
  })
})

describe('changes are a human’s own act (D11)', () => {
  it.each([
    ['domains.set_target', { host: 'www.eigenenterprise.app', shows: { kind: 'site' } }],
    ['domains.remove', { host: 'eigenenterprise.app' }],
    ['domains.retry_certificate', { host: 'eigenenterprise.app' }],
  ])('%s refuses the agent before ee is touched', async (name, input) => {
    const { by, ee } = tools()
    await expect(by.get(name)!.handler(agent, input)).rejects.toMatchObject({
      code: 'permission_denied',
    })
    expect(ee.calls).toEqual([])
  })

  it('set_target: the company website takes the app’s host, the answer says what it showed before', async () => {
    const { by, ee } = tools()
    const out = await by
      .get('domains.set_target')!
      .handler(human, { host: 'EigenEnterprise.app', shows: { kind: 'site' } })
    expect(ee.calls).toEqual([
      {
        verb: 'addDomain',
        input: {
          host: 'eigenenterprise.app',
          workload: 'os',
          role: 'public',
          author: 'human:owner-1',
        },
      },
    ])
    expect(out).toMatchObject({
      replaced: 'eigen-enterprise-website',
      message:
        'eigenenterprise.app now shows the company website instead of the app eigen-enterprise-website.',
    })
    expect(by.get('domains.set_target')!.activity!({ host: 'eigenenterprise.app' }, out)).toBe(
      'eigenenterprise.app now shows the company website instead of the app eigen-enterprise-website.',
    )
  })

  it('set_target refuses calls as a target (it follows the console host)', () => {
    const { by } = tools()
    expect(
      by
        .get('domains.set_target')!
        .inputSchema.safeParse({ host: 'a.example.com', shows: { kind: 'calls' } }).success,
    ).toBe(false)
  })

  it('retry_certificate asks ee for that host', async () => {
    const { by, ee } = tools()
    await by.get('domains.retry_certificate')!.handler(human, { host: 'eigenenterprise.app' })
    expect(ee.calls).toEqual([
      { verb: 'retryCertificate', input: { host: 'eigenenterprise.app', author: 'human:owner-1' } },
    ])
  })
})
