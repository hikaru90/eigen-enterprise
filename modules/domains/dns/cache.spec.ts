import type { DnsResolver } from './observe'
import { describe, expect, it } from 'vitest'
import { cachedResolver } from './cache'

function countingResolver() {
  const calls: string[] = []
  let failNext: string | null = null
  const resolver: DnsResolver = {
    resolve4: async (n) => {
      calls.push(`A ${n}`)
      if (failNext) {
        const code = failNext
        failNext = null
        throw Object.assign(new Error(code), { code })
      }
      return ['203.0.113.7']
    },
    resolve6: async (n) => {
      calls.push(`AAAA ${n}`)
      return ['2001:db8::7']
    },
    resolveCname: async (n) => {
      calls.push(`CNAME ${n}`)
      return ['x.example.com']
    },
    resolveTxt: async (n) => {
      calls.push(`TXT ${n}`)
      return [['v=spf1']]
    },
    resolveMx: async (n) => {
      calls.push(`MX ${n}`)
      return [{ exchange: 'mx.example.com', priority: 10 }]
    },
  }
  return {
    resolver,
    calls,
    fail: (code: string) => {
      failNext = code
    },
  }
}

describe('cachedResolver', () => {
  it('answers a repeated (name, type) from the cache within the TTL', async () => {
    let t = 0
    const { resolver, calls } = countingResolver()
    const cached = cachedResolver(resolver, 60_000, () => t)
    expect(await cached.resolve4('a.kindred.com')).toEqual(['203.0.113.7'])
    t = 59_999
    expect(await cached.resolve4('a.kindred.com')).toEqual(['203.0.113.7'])
    expect(calls).toEqual(['A a.kindred.com'])
  })

  it('looks up again once the TTL has passed', async () => {
    let t = 0
    const { resolver, calls } = countingResolver()
    const cached = cachedResolver(resolver, 60_000, () => t)
    await cached.resolve4('a.kindred.com')
    t = 60_000
    await cached.resolve4('a.kindred.com')
    expect(calls).toEqual(['A a.kindred.com', 'A a.kindred.com'])
  })

  it('keys on name and type separately', async () => {
    const { resolver, calls } = countingResolver()
    const cached = cachedResolver(resolver, 60_000, () => 0)
    await cached.resolve4('a.kindred.com')
    await cached.resolve6('a.kindred.com')
    await cached.resolveTxt('a.kindred.com')
    await cached.resolveMx('a.kindred.com')
    await cached.resolveCname('a.kindred.com')
    await cached.resolve4('b.kindred.com')
    await cached.resolveTxt('a.kindred.com')
    expect(calls).toEqual([
      'A a.kindred.com',
      'AAAA a.kindred.com',
      'TXT a.kindred.com',
      'MX a.kindred.com',
      'CNAME a.kindred.com',
      'A b.kindred.com',
    ])
  })

  it('shares one in-flight lookup between concurrent callers', async () => {
    const { resolver, calls } = countingResolver()
    const cached = cachedResolver(resolver, 60_000, () => 0)
    await Promise.all([cached.resolve4('a.kindred.com'), cached.resolve4('a.kindred.com')])
    expect(calls).toEqual(['A a.kindred.com'])
  })

  it('caches a failure for the TTL too (the same answer until "Check now")', async () => {
    const { resolver, calls, fail } = countingResolver()
    const cached = cachedResolver(resolver, 60_000, () => 0)
    fail('ENOTFOUND')
    await expect(cached.resolve4('a.kindred.com')).rejects.toMatchObject({ code: 'ENOTFOUND' })
    await expect(cached.resolve4('a.kindred.com')).rejects.toMatchObject({ code: 'ENOTFOUND' })
    expect(calls).toEqual(['A a.kindred.com'])
  })

  it('forget(name) drops every type cached for that name, and only that name', async () => {
    const { resolver, calls } = countingResolver()
    const cached = cachedResolver(resolver, 60_000, () => 0)
    await cached.resolve4('a.kindred.com')
    await cached.resolveTxt('a.kindred.com')
    await cached.resolve4('b.kindred.com')
    cached.forget('A.Kindred.com.')
    await cached.resolve4('a.kindred.com')
    await cached.resolveTxt('a.kindred.com')
    await cached.resolve4('b.kindred.com')
    expect(calls).toEqual([
      'A a.kindred.com',
      'TXT a.kindred.com',
      'A b.kindred.com',
      'A a.kindred.com',
      'TXT a.kindred.com',
    ])
  })

  it('refuses a non-positive TTL', () => {
    const { resolver } = countingResolver()
    expect(() => cachedResolver(resolver, 0, () => 0)).toThrow(/ttl/i)
  })
})
