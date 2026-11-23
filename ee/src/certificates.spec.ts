import { describe, expect, it } from 'vitest'
import { certificatePath, CADDY_LOG_LINES, observeCaddyLog, readCertificates, servedHosts } from './certificates.ts'
import { PATHS } from './paths.ts'
import type { RunResult, System } from './system.ts'

/** A self-signed leaf for shop.example.com, notAfter 2036-11-19T17:32:40Z (openssl req -x509 -days 3650). */
const PEM = `-----BEGIN CERTIFICATE-----
MIIB8TCCAVqgAwIBAgIUTzHJ450JemSZ1Ua5+ntNFl5r1TowDQYJKoZIhvcNAQEL
BQAwGzEZMBcGA1UEAwwQc2hvcC5leGFtcGxlLmNvbTAeFw0yNjExMjIxNzMyNDBa
Fw0zNjExMTkxNzMyNDBaMBsxGTAXBgNVBAMMEHNob3AuZXhhbXBsZS5jb20wgZ8w
DQYJKoZIhvcNAQEBBQADgY0AMIGJAoGBANG436OpVqiLgxKOljsgo8/PpM4YWkbc
mlWxCEo/UwWzLoa1RPF//byPkUVybO7o1SOPxEV9l04uhBouJ64JO/iJIVtAQkJa
2BLRdoN+DxrTgfDAHoFQle/aUrJXlOUJpYk4L1Yer6xfu9OGxRoOLPzcyv3dnM+E
LWMx2u2qOsUXAgMBAAGjMjAwMB0GA1UdDgQWBBRzIojBcryI0GFVqsUsVcJvkKzU
czAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4GBAJSHrBBKVSX7pYbD
cWEHnW4Qk/cdReUjkf0UXuF4hppc4yq2EyVXvVbcUnq1bbN6q5SKehZsXSMk91f5
E1Lv6O1WBEoEgGIvlAqGdi+E6Rqs2/TlnyapRngIGxNYNoaP/DH8GxAY6iyqHwv0
bnAoxlCF9x2jk4YLjc04SpDK+YaE
-----END CERTIFICATE-----
`
const NOT_AFTER = '2036-11-19T17:32:40.000Z'

const T0 = Date.parse('2026-11-22T10:00:00Z') / 1000
const line = (o: Record<string, unknown>) => JSON.stringify({ level: 'info', ts: T0, ...o })
const failed = (host: string, ts: number, error = 'HTTP 400 urn:ietf:params:acme:error:connection: Timeout during connect') =>
  line({ level: 'error', ts, logger: 'tls.obtain', msg: 'could not get certificate from issuer', identifier: host, issuer: 'acme-v02.api.letsencrypt.org-directory', error })
const willRetry = (ts: number, seconds: number) =>
  line({ level: 'error', ts, logger: 'tls.obtain', msg: 'will retry', error: '[x] Obtain: …', attempt: 7, retrying_in: seconds, elapsed: 3000, max_duration: 2592000 })

class Box implements Partial<System> {
  files = new Map<string, string>()
  journal: RunResult = { code: 0, stdout: '', stderr: '' }
  runs: Array<{ cmd: string; args: string[] }> = []
  at = new Date('2026-11-22T12:00:00Z')
  async readFile(p: string) {
    return this.files.get(p) ?? null
  }
  async run(cmd: string, args: string[]) {
    this.runs.push({ cmd, args })
    return this.journal
  }
  now() {
    return this.at
  }
}
const sys = (b: Box) => b as unknown as System

describe('where Caddy keeps a certificate', () => {
  it('public hosts under the Let’s Encrypt issuer, reserved names under the local CA, in the storage ee pins', () => {
    expect(certificatePath('shop.example.com')).toBe(`${PATHS.caddyStorage}/certificates/acme-v02.api.letsencrypt.org-directory/shop.example.com/shop.example.com.crt`)
    expect(certificatePath('os.ee.localhost')).toBe(`${PATHS.caddyStorage}/certificates/local/os.ee.localhost/os.ee.localhost.crt`)
  })

  it('every host ee serves: routes, the console host and the calls host, once each', () => {
    const hosts = servedHosts(
      { consoleHost: 'os.example.com', callsHost: 'rtc.os.example.com' },
      [
        { host: 'os.example.com', workload: 'os' },
        { host: 'shop.example.com', workload: 'shop' },
      ],
    )
    expect(hosts).toEqual(['os.example.com', 'rtc.os.example.com', 'shop.example.com'])
  })
})

describe("Caddy's structured log (tls.obtain / tls.renew)", () => {
  it('a failure with its retry: last error and next retry, from the JSON fields', () => {
    const seen = observeCaddyLog([failed('shop.example.com', T0), willRetry(T0 + 1, 600)])
    expect(seen.get('shop.example.com')).toEqual({
      outcome: 'failed',
      lastError: 'HTTP 400 urn:ietf:params:acme:error:connection: Timeout during connect',
      nextRetryAt: new Date((T0 + 601) * 1000).toISOString(),
    })
  })

  it('a later success clears the error', () => {
    const seen = observeCaddyLog([
      failed('shop.example.com', T0),
      willRetry(T0 + 1, 60),
      line({ ts: T0 + 70, logger: 'tls.obtain', msg: 'obtaining certificate', identifier: 'shop.example.com' }),
      line({ ts: T0 + 80, logger: 'tls.obtain', msg: 'certificate obtained successfully', identifier: 'shop.example.com', issuer: 'acme-v02.api.letsencrypt.org-directory' }),
    ])
    expect(seen.get('shop.example.com')).toEqual({ outcome: 'obtained', lastError: null, nextRetryAt: null })
  })

  it('a new attempt after a failure is in progress: no retry time, the last error kept', () => {
    const seen = observeCaddyLog([
      failed('shop.example.com', T0),
      willRetry(T0 + 1, 60),
      line({ ts: T0 + 70, logger: 'tls.obtain', msg: 'obtaining certificate', identifier: 'shop.example.com' }),
    ])
    expect(seen.get('shop.example.com')).toMatchObject({ outcome: 'trying', nextRetryAt: null, lastError: expect.stringMatching(/Timeout/) })
  })

  it('"will retry" carries no identifier: with two hosts failing at once it is not attributed (never guessed)', () => {
    const seen = observeCaddyLog([failed('a.example.com', T0), failed('b.example.com', T0), willRetry(T0 + 1, 600)])
    expect(seen.get('a.example.com')).toMatchObject({ outcome: 'failed', nextRetryAt: null })
    expect(seen.get('b.example.com')).toMatchObject({ outcome: 'failed', nextRetryAt: null })
  })

  it('giving up leaves no retry time', () => {
    const seen = observeCaddyLog([
      failed('shop.example.com', T0),
      line({ level: 'error', ts: T0 + 1, logger: 'tls.obtain', msg: 'final attempt; giving up', error: 'x', attempt: 40 }),
    ])
    expect(seen.get('shop.example.com')).toMatchObject({ outcome: 'failed', nextRetryAt: null })
  })

  it('renewals are read the same way', () => {
    const seen = observeCaddyLog([
      line({ level: 'error', ts: T0, logger: 'tls.renew', msg: 'could not get certificate from issuer', identifier: 'shop.example.com', error: 'rate limited' }),
      line({ level: 'error', ts: T0 + 1, logger: 'tls.renew', msg: 'will retry', error: 'x', retrying_in: 120 }),
    ])
    expect(seen.get('shop.example.com')).toEqual({ outcome: 'failed', lastError: 'rate limited', nextRetryAt: new Date((T0 + 121) * 1000).toISOString() })
  })

  it('lines that are not Caddy JSON, or other loggers, are skipped', () => {
    const seen = observeCaddyLog(['-- No entries --', '{not json', line({ logger: 'http', msg: 'server running' }), ''])
    expect(seen.size).toBe(0)
  })
})

describe('readCertificates', () => {
  it('issued: the stored certificate and its notAfter', async () => {
    const b = new Box()
    b.files.set(certificatePath('shop.example.com'), PEM)
    expect(await readCertificates(sys(b), ['shop.example.com'])).toEqual([
      { host: 'shop.example.com', state: 'issued', lastError: null, nextRetryAt: null, notAfter: NOT_AFTER },
    ])
    expect(b.runs).toEqual([{ cmd: 'journalctl', args: ['-u', 'caddy.service', '-o', 'cat', '--no-pager', '-n', String(CADDY_LOG_LINES)] }])
  })

  it('failing: no certificate and the last attempt failed (the production backoff)', async () => {
    const b = new Box()
    b.journal = { code: 0, stdout: [failed('eigenenterprise.app', T0), willRetry(T0 + 1, 600)].join('\n') + '\n', stderr: '' }
    expect(await readCertificates(sys(b), ['eigenenterprise.app'])).toEqual([
      {
        host: 'eigenenterprise.app',
        state: 'failing',
        lastError: 'HTTP 400 urn:ietf:params:acme:error:connection: Timeout during connect',
        nextRetryAt: new Date((T0 + 601) * 1000).toISOString(),
        notAfter: null,
      },
    ])
  })

  it('pending: nothing stored and nothing in the log yet', async () => {
    expect(await readCertificates(sys(new Box()), ['new.example.com'])).toEqual([
      { host: 'new.example.com', state: 'pending', lastError: null, nextRetryAt: null, notAfter: null },
    ])
  })

  it('a valid certificate whose renewal fails stays issued and shows the renewal error', async () => {
    const b = new Box()
    b.files.set(certificatePath('shop.example.com'), PEM)
    b.journal = { code: 0, stdout: line({ level: 'error', logger: 'tls.renew', msg: 'could not get certificate from issuer', identifier: 'shop.example.com', error: 'rate limited' }), stderr: '' }
    expect((await readCertificates(sys(b), ['shop.example.com']))[0]).toMatchObject({ state: 'issued', lastError: 'rate limited', notAfter: NOT_AFTER })
  })

  it('an expired certificate is not issued; its notAfter is still shown', async () => {
    const b = new Box()
    b.at = new Date('2037-01-01T00:00:00Z')
    b.files.set(certificatePath('shop.example.com'), PEM)
    expect((await readCertificates(sys(b), ['shop.example.com']))[0]).toEqual({ host: 'shop.example.com', state: 'pending', lastError: null, nextRetryAt: null, notAfter: NOT_AFTER })
  })

  it('a stored file that is not a certificate is reported as failing with that reason', async () => {
    const b = new Box()
    b.files.set(certificatePath('shop.example.com'), 'garbage')
    const [c] = await readCertificates(sys(b), ['shop.example.com'])
    expect(c).toMatchObject({ state: 'failing', notAfter: null, lastError: expect.stringMatching(/could not be read/) })
  })

  it("an unreadable Caddy log is said, not hidden, for hosts without a certificate", async () => {
    const b = new Box()
    b.files.set(certificatePath('shop.example.com'), PEM)
    b.journal = { code: 1, stdout: '', stderr: 'Failed to open journal' }
    const out = await readCertificates(sys(b), ['shop.example.com', 'new.example.com'])
    expect(out[0]).toMatchObject({ state: 'issued', lastError: null })
    expect(out[1]).toMatchObject({ state: 'pending', nextRetryAt: null, lastError: expect.stringMatching(/Caddy's log could not be read: Failed to open journal/) })
  })
})
