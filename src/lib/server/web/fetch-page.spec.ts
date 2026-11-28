import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fetchPublicUrl, liveFetchDeps, WebFetchError, type FetchDeps } from './fetch-page'

let server: Server
let base: string

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' })
      res.end(gzipSync('<title>Hi</title><p>Hello</p>'))
    } else if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('x'.repeat(5000))
    } else if (req.url === '/to-private') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' })
      res.end()
    } else if (req.url === '/to-page') {
      res.writeHead(301, { location: '/page' })
      res.end()
    } else if (req.url === '/loop') {
      res.writeHead(302, { location: '/loop' })
      res.end()
    } else if (req.url === '/slow') {
      setTimeout(() => res.end('late'), 2000)
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://localhost:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

/** The test server is on loopback: allow exactly 127.0.0.1, keep the real check for anything else. */
const testDeps: FetchDeps = { resolve: liveFetchDeps.resolve, isAllowed: (a) => a === '127.0.0.1' || liveFetchDeps.isAllowed(a) }
const onlyV4: FetchDeps = { resolve: async () => [{ address: '127.0.0.1', family: 4 }], isAllowed: testDeps.isAllowed }

describe('fetchPublicUrl', () => {
  it('fetches, decompresses and follows a redirect', async () => {
    const page = await fetchPublicUrl(`${base}/to-page`, {}, onlyV4)
    expect(page).toMatchObject({ status: 200, contentType: 'text/html', truncated: false })
    expect(page.url).toMatch(/\/page$/)
    expect(page.body.toString()).toBe('<title>Hi</title><p>Hello</p>')
  })

  it('cuts at the byte cap and says so', async () => {
    const page = await fetchPublicUrl(`${base}/big`, { maxBytes: 100 }, onlyV4)
    expect(page.body.length).toBe(100)
    expect(page.truncated).toBe(true)
  })

  it('refuses loopback, private hosts and a redirect into the metadata address', async () => {
    const err = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e)
    expect(await err(fetchPublicUrl(`${base}/page`))).toMatchObject({ code: 'blocked_address' })
    expect(await err(fetchPublicUrl('http://127.0.0.1/'))).toMatchObject({ code: 'blocked_address' })
    expect(await err(fetchPublicUrl('http://[::1]/'))).toMatchObject({ code: 'blocked_address' })
    expect(await err(fetchPublicUrl(`${base}/to-private`, {}, onlyV4))).toMatchObject({ code: 'blocked_address' })
  })

  it('refuses other schemes, credentials, redirect loops and slow hosts', async () => {
    const err = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e)
    expect(await err(fetchPublicUrl('file:///etc/passwd'))).toMatchObject({ code: 'invalid_url' })
    expect(await err(fetchPublicUrl('ftp://example.com/'))).toMatchObject({ code: 'invalid_url' })
    expect(await err(fetchPublicUrl('https://u:p@example.com/'))).toMatchObject({ code: 'invalid_url' })
    expect(await err(fetchPublicUrl(`${base}/loop`, {}, onlyV4))).toMatchObject({ code: 'too_many_redirects' })
    const slow = await err(fetchPublicUrl(`${base}/slow`, { timeoutMs: 200 }, onlyV4))
    expect(slow).toBeInstanceOf(WebFetchError)
    expect(slow).toMatchObject({ code: 'timeout' })
  })
})
