import { describe, expect, it } from 'vitest'
import { SubstrateError, SubstrateUnavailableError, type EeStatus } from '$lib/server/ee/client'
import {
  describeShows,
  HostTargetError,
  planTarget,
  removeTarget,
  setTarget,
  showsOf,
  type TargetsEe,
} from './targets'

type Settings = EeStatus['settings']

/** ee's domain verbs in memory: records calls, moves routes the way ee/src/domains.ts does. */
class HostsEe implements TargetsEe {
  calls: Array<{ verb: string; input: unknown }> = []
  settings: Settings = {
    consoleHost: 'one.eigenenterprise.app',
    publicHost: 'eigenenterprise.app',
    acmeEmail: null,
    callsHost: 'rtc.one.eigenenterprise.app',
  }
  routes: EeStatus['routes'] = [
    { host: 'one.eigenenterprise.app', workload: 'os' },
    { host: 'eigenenterprise.app', workload: 'os' },
    { host: 'rtc.one.eigenenterprise.app', workload: 'livekit' },
    { host: 'shop.eigenenterprise.app', workload: 'shop' },
  ]
  fail: Error | null = null

  async status(): Promise<EeStatus> {
    if (this.fail) throw this.fail
    return {
      appliedRev: 'x',
      desiredRev: 'x',
      lastReconcileError: null,
      settings: this.settings,
      routes: this.routes,
      certificates: [],
      workloads: [],
      events: [],
    }
  }
  async addDomain(i: Parameters<TargetsEe['addDomain']>[0]) {
    this.calls.push({ verb: 'addDomain', input: i })
    const previous = this.routes.find((r) => r.host === i.host)?.workload ?? null
    let routes = this.routes.filter((r) => r.host !== i.host)
    if (i.role === 'public' && this.settings.publicHost) {
      routes = routes.filter((r) => r.host !== this.settings.publicHost)
      this.settings = { ...this.settings, publicHost: i.host }
    } else if (i.role === 'public') this.settings = { ...this.settings, publicHost: i.host }
    this.routes = [...routes, { host: i.host, workload: i.workload }]
    return {
      rev: 'r',
      reconcileError: null,
      replaced: previous !== null && previous !== i.workload ? previous : null,
    }
  }
  async removeDomain(i: { host: string; author: string }) {
    this.calls.push({ verb: 'removeDomain', input: i })
    this.routes = this.routes.filter((r) => r.host !== i.host)
    if (this.settings.publicHost === i.host) this.settings = { ...this.settings, publicHost: null }
    return { rev: 'r', reconcileError: null }
  }
}

const author = 'human:owner-1'

describe('showsOf: what ee serves on a host, from its settings and routes', () => {
  it('the console, calls, the site, an app, nothing', async () => {
    const s = await new HostsEe().status()
    expect(showsOf(s, 'one.eigenenterprise.app')).toEqual({ kind: 'console' })
    expect(showsOf(s, 'rtc.one.eigenenterprise.app')).toEqual({ kind: 'calls' })
    expect(showsOf(s, 'eigenenterprise.app')).toEqual({ kind: 'site' })
    expect(showsOf(s, 'shop.eigenenterprise.app')).toEqual({ kind: 'app', app: 'shop' })
    expect(showsOf(s, 'www.eigenenterprise.app')).toEqual({ kind: 'nothing' })
  })

  it('an eigenEnterprise route that is neither console nor site breaks ee’s rule: loud', async () => {
    const ee = new HostsEe()
    ee.routes = [...ee.routes, { host: 'odd.example.com', workload: 'os' }]
    expect(() => showsOf({ settings: ee.settings, routes: ee.routes }, 'odd.example.com')).toThrow(
      /neither/,
    )
  })

  it('in words', () => {
    expect(describeShows({ kind: 'site' })).toBe('the company website')
    expect(describeShows({ kind: 'app', app: 'shop' })).toBe('the app shop')
  })
})

describe('setTarget: switching what a host shows is an ordinary change, never silent', () => {
  it('the company website’s host now shows an app: one ee call, the sentence names what it showed before', async () => {
    const ee = new HostsEe()
    const out = await setTarget(ee, {
      host: 'eigenenterprise.app',
      shows: { kind: 'app', app: 'shop' },
      author,
    })
    expect(ee.calls).toEqual([
      {
        verb: 'addDomain',
        input: { host: 'eigenenterprise.app', workload: 'shop', role: 'app', author },
      },
    ])
    expect(out).toMatchObject({
      changed: true,
      before: { kind: 'site' },
      shows: { kind: 'app', app: 'shop' },
      replaced: 'os',
      message: 'eigenenterprise.app now shows the app shop instead of the company website.',
    })
  })

  it('a free host shows the site: the old site host is named as no longer showing it', async () => {
    const ee = new HostsEe()
    const out = await setTarget(ee, {
      host: 'www.eigenenterprise.app',
      shows: { kind: 'site' },
      author,
    })
    expect(ee.calls[0]?.input).toMatchObject({
      host: 'www.eigenenterprise.app',
      role: 'public',
      workload: 'os',
    })
    expect(out.moved).toBe('eigenenterprise.app')
    expect(out.message).toBe(
      'www.eigenenterprise.app now shows the company website. eigenenterprise.app no longer shows it.',
    )
  })

  it('an app takes another app’s host', async () => {
    const ee = new HostsEe()
    const out = await setTarget(ee, {
      host: 'shop.eigenenterprise.app',
      shows: { kind: 'app', app: 'blog' },
      author,
    })
    expect(out.message).toBe(
      'shop.eigenenterprise.app now shows the app blog instead of the app shop.',
    )
    expect(out.replaced).toBe('shop')
  })

  it('already showing it: no ee call, says so', async () => {
    const ee = new HostsEe()
    const out = await setTarget(ee, {
      host: 'shop.eigenenterprise.app',
      shows: { kind: 'app', app: 'shop' },
      author,
    })
    expect(ee.calls).toEqual([])
    expect(out).toMatchObject({
      changed: false,
      message: 'shop.eigenenterprise.app already shows the app shop.',
    })
  })

  it('nothing: removes the host', async () => {
    const ee = new HostsEe()
    const out = await setTarget(ee, {
      host: 'shop.eigenenterprise.app',
      shows: { kind: 'nothing' },
      author,
    })
    expect(ee.calls).toEqual([
      { verb: 'removeDomain', input: { host: 'shop.eigenenterprise.app', author } },
    ])
    expect(out.message).toBe('shop.eigenenterprise.app no longer shows the app shop.')
  })

  it('the console’s host and the calls host cannot show anything else (ee derives them): refused before any ee call', async () => {
    const ee = new HostsEe()
    await expect(
      setTarget(ee, { host: 'one.eigenenterprise.app', shows: { kind: 'site' }, author }),
    ).rejects.toThrow(/shows the console\. Give the console another address first/)
    await expect(
      setTarget(ee, {
        host: 'rtc.one.eigenenterprise.app',
        shows: { kind: 'app', app: 'shop' },
        author,
      }),
    ).rejects.toThrow(/is the calls address/)
    expect(ee.calls).toEqual([])
  })

  it('ee unavailable or refusing: plain words, the cause kept', async () => {
    const ee = new HostsEe()
    ee.fail = new SubstrateUnavailableError('ENOENT')
    await expect(
      setTarget(ee, { host: 'a.example.com', shows: { kind: 'site' }, author }),
    ).rejects.toBeInstanceOf(HostTargetError)
    ee.fail = null
    ee.addDomain = async () => {
      throw new SubstrateError(400, 'no workload blog')
    }
    await expect(
      setTarget(ee, { host: 'a.example.com', shows: { kind: 'app', app: 'blog' }, author }),
    ).rejects.toThrow('The server did not point a.example.com at the app blog: no workload blog.')
  })
})

describe('planTarget: the checks a deploy runs before it builds', () => {
  it('names what the host shows and what moves away', async () => {
    const s = await new HostsEe().status()
    expect(planTarget(s, 'new.example.com', { kind: 'console' })).toEqual({
      before: { kind: 'nothing' },
      moved: 'one.eigenenterprise.app',
    })
    expect(() => planTarget(s, 'one.eigenenterprise.app', { kind: 'app', app: 'x1' })).toThrow(
      HostTargetError,
    )
  })
})

describe('removeTarget', () => {
  it('removes a host and says what it no longer shows', async () => {
    const ee = new HostsEe()
    const out = await removeTarget(ee, { host: 'eigenenterprise.app', author })
    expect(out.message).toBe('eigenenterprise.app no longer shows the company website.')
  })

  it('with expect: only a host showing exactly that', async () => {
    const ee = new HostsEe()
    await expect(
      removeTarget(ee, {
        host: 'eigenenterprise.app',
        author,
        expect: { kind: 'app', app: 'shop' },
      }),
    ).rejects.toThrow(
      'eigenenterprise.app shows the company website, not the app shop, so it is not removed here.',
    )
    expect(ee.calls).toEqual([])
  })

  it('refuses nothing, the console and calls', async () => {
    const ee = new HostsEe()
    await expect(removeTarget(ee, { host: 'www.eigenenterprise.app', author })).rejects.toThrow(
      /shows nothing/,
    )
    await expect(removeTarget(ee, { host: 'one.eigenenterprise.app', author })).rejects.toThrow(
      /shows the console/,
    )
    await expect(removeTarget(ee, { host: 'rtc.one.eigenenterprise.app', author })).rejects.toThrow(
      /calls address/,
    )
    expect(ee.calls).toEqual([])
  })
})
