import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeS3 } from './fake-s3.ts'
import { S3Client, S3Error, signV4 } from './s3.ts'

describe('SigV4', () => {
  it('matches the AWS documented example (GET object, us-east-1)', () => {
    // docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html — "GET Object" example
    const h = signV4({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      query: {},
      headers: { range: 'bytes=0-9' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      now: new Date('2013-05-24T00:00:00Z'),
    })
    expect(h['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    )
  })
})

describe('S3Client against the in-process fake (every request signature-checked)', () => {
  const fake = new FakeS3()
  let endpoint = ''
  beforeAll(async () => {
    endpoint = await fake.start()
  })
  afterAll(() => fake.stop())

  it('put, get, list (paginated), delete — keys with spaces and unicode', async () => {
    const s3 = new S3Client(fake.target(endpoint))
    await s3.putObject(s3.key('a b/ü.txt'), Buffer.from('hello'))
    expect((await s3.getBuffer(s3.key('a b/ü.txt'))).toString()).toBe('hello')
    for (let i = 0; i < 5; i++) await s3.putObject(s3.key(`many/${i}`), Buffer.from([i]))
    fake.pageSize = 2
    expect((await s3.list(s3.key('many/'))).map((o) => o.key)).toEqual([0, 1, 2, 3, 4].map((i) => `acme/many/${i}`))
    fake.pageSize = 1000
    await s3.deleteObject(s3.key('a b/ü.txt'))
    await expect(s3.getBuffer(s3.key('a b/ü.txt'))).rejects.toMatchObject({ status: 404, code: 'NoSuchKey' })
  })

  it('a wrong secret is refused by the server (signature checked)', async () => {
    const s3 = new S3Client({ ...fake.target(endpoint), secretAccessKey: 'nope' })
    await expect(s3.putObject('x', Buffer.from('1'))).rejects.toMatchObject({ code: 'SignatureDoesNotMatch' })
  })

  it('small streams go up in one PUT; large ones as multipart, reassembled in order', async () => {
    const s3 = new S3Client(fake.target(endpoint), { partSize: 10 })
    fake.log.length = 0
    expect(await s3.upload('small', Readable.from([Buffer.from('0123456789')]))).toBe(10)
    expect(fake.log).toEqual(['PUT small'])
    fake.log.length = 0
    const big = Buffer.from('abcdefghijklmnopqrstuvwxyz0123456789')
    expect(await s3.upload('big', Readable.from([big.subarray(0, 7), big.subarray(7, 30), big.subarray(30)]))).toBe(36)
    expect(fake.objects.get('big')).toEqual(big)
    expect(fake.log.filter((l) => l.startsWith('PUT big?')).length).toBe(4)
    expect(fake.log[0]).toBe('POST big?uploads')
  })

  it('a failed part aborts the multipart upload and rethrows', async () => {
    const s3 = new S3Client(fake.target(endpoint), { partSize: 10 })
    fake.failParts = 1
    await expect(s3.upload('broken', Readable.from([Buffer.alloc(25)]))).rejects.toBeInstanceOf(S3Error)
    expect(fake.openUploads).toBe(0)
    expect(fake.objects.has('broken')).toBe(false)
  })

  it('an unreachable endpoint fails loud', async () => {
    const s3 = new S3Client({ ...fake.target('http://127.0.0.1:1') })
    await expect(s3.putObject('x', Buffer.from('1'))).rejects.toThrow(/unreachable/)
  })

  it('virtual-host addressing puts the bucket in the host', () => {
    const s3 = new S3Client({ ...fake.target('https://s3.eu-central-1.example.com'), addressing: 'virtual' })
    expect((s3 as unknown as { where(k: string): unknown }).where('acme/x y')).toEqual({ host: 'test-bucket.s3.eu-central-1.example.com', path: '/acme/x%20y' })
    const p = new S3Client(fake.target('https://s3.example.com'))
    expect((p as unknown as { where(k: string): unknown }).where('acme/x')).toEqual({ host: 's3.example.com', path: '/test-bucket/acme/x' })
  })
})
