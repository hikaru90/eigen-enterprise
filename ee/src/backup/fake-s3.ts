import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { signV4, type S3Target } from './s3.ts'

/**
 * An in-process S3 for tests: path-style buckets, PUT/GET/DELETE, ListObjectsV2
 * (paginated), multipart — and it REJECTS any request whose SigV4 signature
 * does not verify, so the client's signing is tested on every call.
 */
export class FakeS3 {
  readonly objects = new Map<string, Buffer>()
  readonly log: string[] = []
  private uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>()
  private server: Server | null = null
  pageSize = 1000
  /** Make the next N part uploads fail with 500 (abort-path tests). */
  failParts = 0

  constructor(
    readonly bucket = 'test-bucket',
    readonly accessKeyId = 'AKIDTEST',
    readonly secretAccessKey = 'fake-secret',
    readonly region = 'us-east-1',
  ) {}

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks)
          const r = this.handle(req.method ?? 'GET', req.url ?? '/', req.headers as Record<string, string>, body)
          res.writeHead(r.status, r.headers ?? {})
          res.end(r.body ?? '')
        } catch (err) {
          res.writeHead(500)
          res.end(String(err))
        }
      })
    })
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r))
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()))
  }

  target(endpoint: string, prefix = 'acme'): S3Target {
    return { endpoint, region: this.region, bucket: this.bucket, prefix, addressing: 'path', accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey }
  }

  keys(prefix = ''): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort()
  }

  private err(status: number, code: string, message = code) {
    return { status, body: `<?xml version="1.0"?><Error><Code>${code}</Code><Message>${message}</Message></Error>` }
  }

  private verify(method: string, url: string, h: Record<string, string>, body: Buffer): string | null {
    const auth = h['authorization'] ?? ''
    const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth)
    if (!m) return 'malformed authorization'
    if (m[1] !== this.accessKeyId) return 'InvalidAccessKeyId'
    if (h['x-amz-content-sha256'] !== createHash('sha256').update(body).digest('hex')) return 'XAmzContentSHA256Mismatch'
    const [path, qs = ''] = url.split('?')
    const query: Record<string, string> = {}
    for (const pair of qs.split('&').filter(Boolean)) {
      const [k, v = ''] = pair.split('=')
      query[decodeURIComponent(k!)] = decodeURIComponent(v)
    }
    const signed = m[4]!.split(';')
    const headers: Record<string, string> = {}
    for (const n of signed) if (!['host', 'x-amz-date', 'x-amz-content-sha256'].includes(n)) headers[n] = h[n] ?? ''
    const d = h['x-amz-date']!
    const now = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`)
    const expect = signV4({ method, host: h['host']!, path: path!, query, headers, payloadHash: h['x-amz-content-sha256']!, region: this.region, accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey, now })
    return expect['authorization'] === auth ? null : 'SignatureDoesNotMatch'
  }

  private handle(method: string, url: string, h: Record<string, string>, body: Buffer): { status: number; headers?: Record<string, string>; body?: string | Buffer } {
    const bad = this.verify(method, url, h, body)
    if (bad) return this.err(403, bad)
    const [rawPath, qs = ''] = url.split('?')
    const q = new URLSearchParams(qs)
    const segs = rawPath!.split('/').slice(1)
    if (segs[0] !== this.bucket) return this.err(404, 'NoSuchBucket')
    const key = segs.slice(1).map(decodeURIComponent).join('/')
    this.log.push(`${method} ${key}${qs ? `?${[...q.keys()].join('&')}` : ''}`)
    if (method === 'GET' && key === '' && q.get('list-type') === '2') {
      const prefix = q.get('prefix') ?? ''
      const all = this.keys(prefix)
      const start = q.get('continuation-token') ? Number(q.get('continuation-token')) : 0
      const page = all.slice(start, start + this.pageSize)
      const more = start + this.pageSize < all.length
      const xml = `<ListBucketResult>${page.map((k) => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key><Size>${this.objects.get(k)!.length}</Size></Contents>`).join('')}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + this.pageSize}</NextContinuationToken>` : ''}</ListBucketResult>`
      return { status: 200, body: xml }
    }
    if (method === 'POST' && q.has('uploads')) {
      const id = randomUUID()
      this.uploads.set(id, { key, parts: new Map() })
      return { status: 200, body: `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>` }
    }
    if (method === 'PUT' && q.has('uploadId')) {
      const u = this.uploads.get(q.get('uploadId')!)
      if (!u) return this.err(404, 'NoSuchUpload')
      if (this.failParts > 0) {
        this.failParts--
        return this.err(500, 'InternalError')
      }
      u.parts.set(Number(q.get('partNumber')), body)
      return { status: 200, headers: { etag: `"${createHash('md5').update(body).digest('hex')}"` } }
    }
    if (method === 'POST' && q.has('uploadId')) {
      const u = this.uploads.get(q.get('uploadId')!)
      if (!u) return this.err(404, 'NoSuchUpload')
      const nums = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((x) => Number(x[1]))
      this.objects.set(u.key, Buffer.concat(nums.map((n) => u.parts.get(n)!)))
      this.uploads.delete(q.get('uploadId')!)
      return { status: 200, body: '<CompleteMultipartUploadResult/>' }
    }
    if (method === 'DELETE' && q.has('uploadId')) {
      this.uploads.delete(q.get('uploadId')!)
      return { status: 204 }
    }
    if (method === 'PUT') {
      this.objects.set(key, body)
      return { status: 200, headers: { etag: '"x"' } }
    }
    if (method === 'GET') {
      const o = this.objects.get(key)
      return o ? { status: 200, body: o } : this.err(404, 'NoSuchKey')
    }
    if (method === 'DELETE') {
      this.objects.delete(key)
      return { status: 204 }
    }
    return this.err(405, 'MethodNotAllowed')
  }

  get openUploads(): number {
    return this.uploads.size
  }
}
