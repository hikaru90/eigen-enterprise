import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { isPublicAddress } from './ssrf'

/**
 * Opening a URL for the AI (web.fetch, wish 133f8e82): http and https only, public addresses only
 * (ssrf.ts, checked at connect time — a DNS answer or a redirect to a private address is refused),
 * at most MAX_REDIRECTS redirects (each one checked again), a hard time limit for the whole
 * request and a byte cap. A body over the cap is cut and reported as `truncated`, never silently.
 * Only GET; no cookies, no credentials.
 */

export const WEB_FETCH_MAX_BYTES = 5 * 1024 * 1024
export const WEB_FETCH_TIMEOUT_MS = 15_000
export const MAX_REDIRECTS = 5

export class WebFetchError extends Error {
  constructor(
    readonly code: 'invalid_url' | 'blocked_address' | 'timeout' | 'too_many_redirects' | 'network',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'WebFetchError'
  }
}

export type FetchedPage = {
  url: string
  status: number
  contentType: string
  body: Buffer
  truncated: boolean
}

export type FetchDeps = {
  /** Every address a hostname resolves to. */
  resolve: (hostname: string) => Promise<LookupAddress[]>
  /** Whether a connection to this address is allowed (ssrf.ts isPublicAddress). */
  isAllowed: (address: string) => boolean
}

export const liveFetchDeps: FetchDeps = {
  resolve: (hostname) =>
    new Promise((resolve, reject) => dnsLookup(hostname, { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)))),
  isAllowed: isPublicAddress,
}

function parseUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new WebFetchError('invalid_url', `“${raw}” is not a URL.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebFetchError('invalid_url', `Only http and https links can be opened, not ${url.protocol.replace(':', '')}.`)
  }
  if (url.username || url.password) throw new WebFetchError('invalid_url', 'Links with a user name or password are not opened.')
  return url
}

function blocked(host: string): WebFetchError {
  return new WebFetchError('blocked_address', `${host} is not on the public internet; only public web pages can be opened.`)
}

/** A lookup that refuses a hostname when ANY address it resolves to is not allowed. */
function guardedLookup(deps: FetchDeps): LookupFunction {
  return (hostname, options, callback) => {
    deps.resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0) return callback(new WebFetchError('network', `${hostname} has no address.`), '', 4)
        if (addresses.some((a) => !deps.isAllowed(a.address))) return callback(blocked(hostname), '', 4)
        if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses)
        callback(null, addresses[0]!.address, addresses[0]!.family)
      },
      (err: unknown) => callback(err as NodeJS.ErrnoException, '', 4),
    )
  }
}

function decoded(res: IncomingMessage): NodeJS.ReadableStream {
  switch ((res.headers['content-encoding'] ?? '').toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return res.pipe(createGunzip())
    case 'deflate':
      return res.pipe(createInflate())
    case 'br':
      return res.pipe(createBrotliDecompress())
    default:
      return res
  }
}

function getOnce(
  url: URL,
  deps: FetchDeps,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ res: IncomingMessage; body?: Buffer; truncated?: boolean }> {
  return new Promise((resolve, reject) => {
    const literal = url.hostname.replace(/^\[|\]$/g, '')
    if (isIP(literal) && !deps.isAllowed(literal)) return reject(blocked(url.hostname))
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: 'GET',
        lookup: guardedLookup(deps),
        signal,
        headers: {
          'User-Agent': 'eigenEnterprise-agent/1.0 (+web.fetch)',
          Accept: 'text/html,application/xhtml+xml,text/plain,application/json,application/pdf,image/*;q=0.9,*/*;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          return resolve({ res })
        }
        const chunks: Buffer[] = []
        let size = 0
        let truncated = false
        const stream = decoded(res)
        stream.on('data', (chunk: Buffer) => {
          if (truncated) return
          const room = maxBytes - size
          if (chunk.length > room) {
            chunks.push(chunk.subarray(0, room))
            size = maxBytes
            truncated = true
            req.destroy()
            resolve({ res, body: Buffer.concat(chunks), truncated })
            return
          }
          chunks.push(chunk)
          size += chunk.length
        })
        stream.on('end', () => resolve({ res, body: Buffer.concat(chunks), truncated }))
        stream.on('error', (err) => (truncated ? undefined : reject(err)))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

export async function fetchPublicUrl(
  raw: string,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
  deps: FetchDeps = liveFetchDeps,
): Promise<FetchedPage> {
  const maxBytes = opts.maxBytes ?? WEB_FETCH_MAX_BYTES
  const timeoutMs = opts.timeoutMs ?? WEB_FETCH_TIMEOUT_MS
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  let url = parseUrl(raw)
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let out: Awaited<ReturnType<typeof getOnce>>
      try {
        out = await getOnce(url, deps, maxBytes, ac.signal)
      } catch (err) {
        if (err instanceof WebFetchError) throw err
        if (ac.signal.aborted) throw new WebFetchError('timeout', `${url.host} did not answer within ${timeoutMs / 1000} seconds.`, { cause: err })
        const why = err instanceof Error ? err.message : String(err)
        throw new WebFetchError('network', `${url.host} could not be reached: ${why}`, { cause: err })
      }
      if (out.body === undefined) {
        url = parseUrl(new URL(out.res.headers.location!, url).toString())
        continue
      }
      return {
        url: url.toString(),
        status: out.res.statusCode ?? 0,
        contentType: (out.res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase(),
        body: out.body,
        truncated: out.truncated ?? false,
      }
    }
    throw new WebFetchError('too_many_redirects', `${raw} redirected more than ${MAX_REDIRECTS} times.`)
  } finally {
    clearTimeout(timer)
  }
}
