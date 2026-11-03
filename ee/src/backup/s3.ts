import type { Readable } from 'node:stream'
import { createHash, createHmac } from 'node:crypto'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { z } from 'zod'

/**
 * A small S3 client, own implementation (no SDK): AWS Signature V4, the five
 * object verbs ee needs (put, multipart, get, list v2, delete) and nothing
 * else. Path-style and virtual-host addressing. Works against AWS S3, Hetzner,
 * Backblaze B2, MinIO. See README.md for why it is not a dependency.
 */

export const s3TargetSchema = z
  .object({
    endpoint: z.string().url().max(400),
    region: z.string().min(1).max(64),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'bucket names are 3–63 lowercase letters, digits, dots or dashes'),
    /** Key prefix inside the bucket, no leading/trailing slash ("" = bucket root). */
    prefix: z.string().max(200).regex(/^([A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*)?$/, 'prefix: letters, digits, . _ - separated by /'),
    addressing: z.enum(['path', 'virtual']),
    accessKeyId: z.string().min(1).max(256),
    secretAccessKey: z.string().min(1).max(512),
  })
  .strict()

export type S3Target = z.infer<typeof s3TargetSchema>

export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const sha256hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest()

/** RFC 3986 encoding as SigV4 wants it (slashes kept in paths). */
export function uriEncode(s: string, keepSlash: boolean): string {
  const enc = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return keepSlash ? enc.replace(/%2F/g, '/') : enc
}

export type SignInput = {
  method: string
  host: string
  path: string // already uri-encoded
  query: Record<string, string>
  headers: Record<string, string>
  payloadHash: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  now: Date
}

/** SigV4: returns the headers to send (incl. authorization). Exported for the fake server's check. */
export function signV4(i: SignInput): Record<string, string> {
  const amzDate = i.now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const day = amzDate.slice(0, 8)
  const headers: Record<string, string> = { ...i.headers, host: i.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': i.payloadHash }
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort()
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ')
  const canonicalQuery = Object.keys(i.query)
    .sort()
    .map((k) => `${uriEncode(k, false)}=${uriEncode(i.query[k]!, false)}`)
    .join('&')
  const canonical = [i.method, i.path, canonicalQuery, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), i.payloadHash].join('\n')
  const scope = `${day}/${i.region}/s3/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n')
  const kDate = hmac(`AWS4${i.secretAccessKey}`, day)
  const kSigning = hmac(hmac(hmac(kDate, i.region), 's3'), 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex')
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  }
}

type Resp = { status: number; headers: IncomingMessage['headers']; body: IncomingMessage }

/** Minimal XML field reader for S3's small, flat responses (never for meaning: parse only). */
function xmlAll(xml: string, tag: string): string[] {
  const out: string[] = []
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g')
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[1]!)
  return out
}
const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

async function readAll(r: Readable): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const c of r) parts.push(c as Buffer)
  return Buffer.concat(parts)
}

export type ListedObject = { key: string; size: number }

export class S3Client {
  /** Objects at most this size go up in one PUT; larger ones use multipart. */
  readonly partSize: number
  private readonly base: URL

  constructor(
    readonly target: S3Target,
    opts: { partSize?: number; now?: () => Date } = {},
  ) {
    this.partSize = opts.partSize ?? 16 * 1024 * 1024
    this.now = opts.now ?? (() => new Date())
    this.base = new URL(target.endpoint)
    if (this.base.protocol !== 'https:' && this.base.protocol !== 'http:') throw new Error(`endpoint must be http(s): ${target.endpoint}`)
  }

  private readonly now: () => Date

  /** Full object key under the configured prefix. */
  key(rel: string): string {
    return this.target.prefix ? `${this.target.prefix}/${rel}` : rel
  }

  private where(key: string | null): { host: string; path: string } {
    const enc = key === null ? '' : uriEncode(key, true)
    const basePath = this.base.pathname.replace(/\/$/, '')
    if (this.target.addressing === 'virtual') {
      return { host: `${this.target.bucket}.${this.base.host}`, path: `${basePath}/${enc}` }
    }
    return { host: this.base.host, path: `${basePath}/${this.target.bucket}${key === null ? '/' : `/${enc}`}` }
  }

  private send(method: string, key: string | null, query: Record<string, string>, body: Buffer | null, extra: Record<string, string> = {}): Promise<Resp> {
    const { host, path } = this.where(key)
    const payload = body ?? Buffer.alloc(0)
    const headers = signV4({
      method,
      host,
      path,
      query,
      headers: { ...extra, ...(body ? { 'content-length': String(payload.length) } : {}) },
      payloadHash: sha256hex(payload),
      region: this.target.region,
      accessKeyId: this.target.accessKeyId,
      secretAccessKey: this.target.secretAccessKey,
      now: this.now(),
    })
    const qs = Object.keys(query)
      .sort()
      .map((k) => `${uriEncode(k, false)}=${uriEncode(query[k]!, false)}`)
      .join('&')
    const req = this.base.protocol === 'https:' ? httpsRequest : httpRequest
    const [hostname, port] = splitHost(host, this.base)
    return new Promise((resolve, reject) => {
      const r = req(
        { method, hostname, port, path: qs ? `${path}?${qs}` : path, headers, timeout: 120_000 },
        (res) => resolve({ status: res.statusCode ?? 500, headers: res.headers, body: res }),
      )
      r.on('timeout', () => r.destroy(new Error(`S3 ${method} ${host}${path}: timed out`)))
      r.on('error', (err) => reject(new S3Error(0, 'network', `S3 endpoint ${this.target.endpoint} unreachable: ${err.message}`)))
      r.end(payload)
    })
  }

  private async ok(res: Resp, what: string): Promise<Buffer> {
    const body = await readAll(res.body)
    if (res.status >= 300) {
      const text = body.toString('utf8')
      const code = xmlAll(text, 'Code')[0] ?? `HTTP${res.status}`
      const msg = xmlAll(text, 'Message')[0] ?? text.slice(0, 200)
      throw new S3Error(res.status, code, `S3 ${what} failed: ${res.status} ${code}${msg ? ` — ${unxml(msg)}` : ''}`)
    }
    return body
  }

  async putObject(key: string, body: Buffer): Promise<void> {
    await this.ok(await this.send('PUT', key, {}, body, { 'content-type': 'application/octet-stream' }), `PUT ${key}`)
  }

  /**
   * Upload a stream: one PUT when it fits in a part, multipart otherwise
   * (an aborted multipart upload is cleaned up before the error is rethrown).
   */
  async upload(key: string, source: AsyncIterable<Buffer>): Promise<number> {
    let buf: Buffer[] = []
    let len = 0
    let total = 0
    let uploadId: string | null = null
    const parts: string[] = []
    const flushPart = async (data: Buffer) => {
      if (uploadId === null) {
        const init = await this.ok(await this.send('POST', key, { uploads: '' }, Buffer.alloc(0)), `initiate multipart ${key}`)
        uploadId = unxml(xmlAll(init.toString('utf8'), 'UploadId')[0] ?? '')
        if (!uploadId) throw new S3Error(500, 'NoUploadId', `S3 multipart ${key}: no UploadId in response`)
      }
      const res = await this.send('PUT', key, { partNumber: String(parts.length + 1), uploadId }, data)
      await this.ok(res, `upload part ${parts.length + 1} of ${key}`)
      const etag = res.headers.etag
      if (!etag) throw new S3Error(500, 'NoETag', `S3 part ${parts.length + 1} of ${key}: no ETag`)
      parts.push(String(etag))
    }
    try {
      for await (const chunk of source) {
        buf.push(chunk)
        len += chunk.length
        total += chunk.length
        while (len > this.partSize) {
          const all = Buffer.concat(buf)
          await flushPart(all.subarray(0, this.partSize))
          buf = [all.subarray(this.partSize)]
          len = buf[0]!.length
        }
      }
      const rest = Buffer.concat(buf)
      if (uploadId === null) {
        await this.putObject(key, rest)
        return total
      }
      if (rest.length > 0) await flushPart(rest)
      const xml = `<CompleteMultipartUpload>${parts.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}</ETag></Part>`).join('')}</CompleteMultipartUpload>`
      const done = await this.ok(await this.send('POST', key, { uploadId }, Buffer.from(xml), { 'content-type': 'application/xml' }), `complete multipart ${key}`)
      // S3 may answer 200 with an <Error> body for a failed completion.
      if (done.toString('utf8').includes('<Error>')) throw new S3Error(500, 'CompleteFailed', `S3 complete multipart ${key} failed: ${done.toString('utf8').slice(0, 300)}`)
      return total
    } catch (err) {
      if (uploadId !== null) {
        await this.send('DELETE', key, { uploadId }, null).then((r) => readAll(r.body)).catch(() => undefined)
      }
      throw err
    }
  }

  /** The object's bytes as a stream; throws S3Error 404 NoSuchKey when missing. */
  async getObject(key: string): Promise<Readable> {
    const res = await this.send('GET', key, {}, null)
    if (res.status >= 300) await this.ok(res, `GET ${key}`)
    return res.body
  }

  async getBuffer(key: string): Promise<Buffer> {
    return readAll(await this.getObject(key))
  }

  /** Create the bucket (test rigs and drills; ee never creates a customer's bucket itself). */
  async createBucket(): Promise<void> {
    const res = await this.send('PUT', null, {}, Buffer.alloc(0))
    if (res.status === 409) return void (await readAll(res.body))
    await this.ok(res, `create bucket ${this.target.bucket}`)
  }

  async deleteObject(key: string): Promise<void> {
    await this.ok(await this.send('DELETE', key, {}, null), `DELETE ${key}`)
  }

  /** Every object under a prefix (ListObjectsV2, paginated). */
  async list(prefix: string): Promise<ListedObject[]> {
    const out: ListedObject[] = []
    let token: string | null = null
    do {
      const q: Record<string, string> = { 'list-type': '2', prefix, 'max-keys': '1000' }
      if (token) q['continuation-token'] = token
      const xml = (await this.ok(await this.send('GET', null, q, null), `LIST ${prefix}`)).toString('utf8')
      for (const c of xmlAll(xml, 'Contents')) {
        out.push({ key: unxml(xmlAll(c, 'Key')[0] ?? ''), size: Number(xmlAll(c, 'Size')[0] ?? 0) })
      }
      token = xmlAll(xml, 'IsTruncated')[0] === 'true' ? unxml(xmlAll(xml, 'NextContinuationToken')[0] ?? '') || null : null
    } while (token)
    return out
  }
}

function splitHost(host: string, base: URL): [string, number | undefined] {
  const port = base.port ? Number(base.port) : undefined
  const hostname = port ? host.slice(0, host.lastIndexOf(':')) : host
  return [hostname, port]
}
