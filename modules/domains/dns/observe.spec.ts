import type { ExpectedRecord } from './records'
import { describe, expect, it } from 'vitest'
import { observe, type DnsResolver } from './observe'

type Answers = {
  A?: Record<string, string[] | Error>
  AAAA?: Record<string, string[] | Error>
  CNAME?: Record<string, string[] | Error>
  TXT?: Record<string, string[][] | Error>
  MX?: Record<string, { exchange: string; priority: number }[] | Error>
}

const dnsError = (code: string) => Object.assign(new Error(`query ${code}`), { code })

/** A fake resolver: answers from a table, NXDOMAIN for anything not in it; records each call. */
function fakeResolver(answers: Answers) {
  const calls: string[] = []
  const answer = <T>(type: keyof Answers, name: string): Promise<T> => {
    calls.push(`${type} ${name}`)
    const a = (answers[type] as Record<string, unknown> | undefined)?.[name]
    if (a === undefined) return Promise.reject(dnsError('ENOTFOUND'))
    if (a instanceof Error) return Promise.reject(a)
    return Promise.resolve(a as T)
  }
  const resolver: DnsResolver = {
    resolve4: (n) => answer('A', n),
    resolve6: (n) => answer('AAAA', n),
    resolveCname: (n) => answer('CNAME', n),
    resolveTxt: (n) => answer('TXT', n),
    resolveMx: (n) => answer('MX', n),
  }
  return { resolver, calls }
}

const a: ExpectedRecord = {
  name: 'one.kindred.com',
  type: 'A',
  value: '203.0.113.7',
  purpose: 'web',
}

describe('observe', () => {
  it('A: ok when the expected address is among the answers', async () => {
    const { resolver } = fakeResolver({ A: { 'one.kindred.com': ['198.51.100.1', '203.0.113.7'] } })
    expect(await observe([a], resolver)).toEqual([
      { ...a, status: 'ok', observed: ['198.51.100.1', '203.0.113.7'], error: null },
    ])
  })

  it('A: wrong with what DNS returns when no answer matches', async () => {
    const { resolver } = fakeResolver({ A: { 'one.kindred.com': ['198.51.100.1'] } })
    expect(await observe([a], resolver)).toEqual([
      { ...a, status: 'wrong', observed: ['198.51.100.1'], error: null },
    ])
  })

  it('NXDOMAIN (ENOTFOUND) is missing', async () => {
    const { resolver } = fakeResolver({})
    expect(await observe([a], resolver)).toEqual([
      { ...a, status: 'missing', observed: [], error: null },
    ])
  })

  it('no records of that type (ENODATA) is missing', async () => {
    const { resolver } = fakeResolver({ A: { 'one.kindred.com': dnsError('ENODATA') } })
    expect((await observe([a], resolver))[0]).toMatchObject({
      status: 'missing',
      observed: [],
      error: null,
    })
  })

  it('an empty answer is missing', async () => {
    const { resolver } = fakeResolver({ A: { 'one.kindred.com': [] } })
    expect((await observe([a], resolver))[0]).toMatchObject({
      status: 'missing',
      observed: [],
      error: null,
    })
  })

  it('any other error is lookup_failed with the code, never missing', async () => {
    for (const code of ['ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED']) {
      const { resolver } = fakeResolver({ A: { 'one.kindred.com': dnsError(code) } })
      expect((await observe([a], resolver))[0]).toMatchObject({
        status: 'lookup_failed',
        observed: [],
        error: code,
      })
    }
  })

  it('an error without a code is lookup_failed with its message', async () => {
    const { resolver } = fakeResolver({ A: { 'one.kindred.com': new Error('resolver exploded') } })
    expect((await observe([a], resolver))[0]).toMatchObject({
      status: 'lookup_failed',
      error: 'resolver exploded',
    })
  })

  it('AAAA compares addresses in canonical form', async () => {
    const aaaa: ExpectedRecord = {
      name: 'one.kindred.com',
      type: 'AAAA',
      value: '2001:0DB8:0:0::7',
      purpose: 'web',
    }
    const { resolver } = fakeResolver({ AAAA: { 'one.kindred.com': ['2001:db8::7'] } })
    expect((await observe([aaaa], resolver))[0]).toMatchObject({
      status: 'ok',
      observed: ['2001:db8::7'],
    })
  })

  it('TXT joins the chunks of each record and compares exactly', async () => {
    const txt: ExpectedRecord = {
      name: 'ee._domainkey.kindred.com',
      type: 'TXT',
      value: 'p=AAAABBBB',
      purpose: 'mail_dkim',
    }
    const { resolver } = fakeResolver({
      TXT: { 'ee._domainkey.kindred.com': [['p=AAAA', 'BBBB'], ['other']] },
    })
    expect((await observe([txt], resolver))[0]).toMatchObject({
      status: 'ok',
      observed: ['p=AAAABBBB', 'other'],
    })
  })

  it('TXT is case- and space-sensitive', async () => {
    const txt: ExpectedRecord = {
      name: '_ee-verify.kindred.com',
      type: 'TXT',
      value: 'ee-Abc',
      purpose: 'claim',
    }
    const { resolver } = fakeResolver({
      TXT: { '_ee-verify.kindred.com': [['ee-abc'], ['ee-Abc ']] },
    })
    expect((await observe([txt], resolver))[0]).toMatchObject({
      status: 'wrong',
      observed: ['ee-abc', 'ee-Abc '],
    })
  })

  it('CNAME compares case-insensitively without trailing dot', async () => {
    const cname: ExpectedRecord = {
      name: 't._domainkey.kindred.com',
      type: 'CNAME',
      value: 't.dkim.amazonses.com',
      purpose: 'mail_dkim',
    }
    const { resolver } = fakeResolver({
      CNAME: { 't._domainkey.kindred.com': ['T.DKIM.AmazonSES.com.'] },
    })
    expect((await observe([cname], resolver))[0]).toMatchObject({
      status: 'ok',
      observed: ['T.DKIM.AmazonSES.com.'],
    })
  })

  it('CNAME pointing elsewhere is wrong', async () => {
    const cname: ExpectedRecord = {
      name: 'www.kindred.com',
      type: 'CNAME',
      value: 'kindred.com',
      purpose: 'web',
    }
    const { resolver } = fakeResolver({ CNAME: { 'www.kindred.com': ['parking.example.net'] } })
    expect((await observe([cname], resolver))[0]).toMatchObject({
      status: 'wrong',
      observed: ['parking.example.net'],
    })
  })

  describe('MX', () => {
    const mx: ExpectedRecord = {
      name: 'mail.kindred.com',
      type: 'MX',
      value: 'feedback-smtp.eu-central-1.amazonses.com',
      priority: 10,
      purpose: 'mail_mail_from_mx',
    }

    it('ok on exchange (case-insensitive, no trailing dot) and priority', async () => {
      const { resolver } = fakeResolver({
        MX: {
          'mail.kindred.com': [
            { exchange: 'Feedback-SMTP.eu-central-1.amazonses.com.', priority: 10 },
          ],
        },
      })
      expect((await observe([mx], resolver))[0]).toMatchObject({
        status: 'ok',
        observed: ['10 Feedback-SMTP.eu-central-1.amazonses.com.'],
      })
    })

    it('wrong when the priority differs', async () => {
      const { resolver } = fakeResolver({
        MX: {
          'mail.kindred.com': [
            { exchange: 'feedback-smtp.eu-central-1.amazonses.com', priority: 20 },
          ],
        },
      })
      expect((await observe([mx], resolver))[0]).toMatchObject({
        status: 'wrong',
        observed: ['20 feedback-smtp.eu-central-1.amazonses.com'],
      })
    })

    it('ignores priority when none is expected', async () => {
      const noPriority: ExpectedRecord = {
        name: mx.name,
        type: 'MX',
        value: mx.value,
        purpose: mx.purpose,
      }
      const { resolver } = fakeResolver({
        MX: {
          'mail.kindred.com': [
            { exchange: 'feedback-smtp.eu-central-1.amazonses.com', priority: 20 },
          ],
        },
      })
      expect((await observe([noPriority], resolver))[0]).toMatchObject({ status: 'ok' })
    })
  })

  it('looks each (name, type) up once even when several records share it, and keeps input order', async () => {
    const spf: ExpectedRecord = {
      name: 'mail.kindred.com',
      type: 'TXT',
      value: 'v=spf1 include:amazonses.com ~all',
      purpose: 'mail_spf',
    }
    const other: ExpectedRecord = {
      name: 'mail.kindred.com',
      type: 'TXT',
      value: 'something-else',
      purpose: 'claim',
    }
    const mx: ExpectedRecord = {
      name: 'mail.kindred.com',
      type: 'MX',
      value: 'x.example.com',
      purpose: 'mail_mail_from_mx',
    }
    const { resolver, calls } = fakeResolver({
      TXT: { 'mail.kindred.com': [['v=spf1 include:amazonses.com ~all']] },
      MX: { 'mail.kindred.com': [{ exchange: 'x.example.com', priority: 10 }] },
    })
    const result = await observe([spf, mx, other], resolver)
    expect([...calls].sort()).toEqual(['MX mail.kindred.com', 'TXT mail.kindred.com'])
    expect(result.map((r) => [r.purpose, r.status])).toEqual([
      ['mail_spf', 'ok'],
      ['mail_mail_from_mx', 'ok'],
      ['claim', 'wrong'],
    ])
  })

  it('a failed lookup for one name does not affect the others', async () => {
    const b: ExpectedRecord = {
      name: 'two.kindred.com',
      type: 'A',
      value: '203.0.113.7',
      purpose: 'web',
    }
    const { resolver } = fakeResolver({
      A: { 'one.kindred.com': dnsError('ETIMEOUT'), 'two.kindred.com': ['203.0.113.7'] },
    })
    expect((await observe([a, b], resolver)).map((r) => r.status)).toEqual(['lookup_failed', 'ok'])
  })

  it('returns an empty list for no expected records without any lookup', async () => {
    const { resolver, calls } = fakeResolver({})
    expect(await observe([], resolver)).toEqual([])
    expect(calls).toEqual([])
  })
})
