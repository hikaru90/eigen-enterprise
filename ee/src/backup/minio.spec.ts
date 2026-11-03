import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { beforeAll, describe, expect, it } from 'vitest'
import { newBackupKey } from './crypto.ts'
import { S3Client, type S3Target } from './s3.ts'
import { BackupService } from './service.ts'
import { driveBlobPath, fetchSnapshot, listSnapshots, prune, takeSnapshot } from './snapshot.ts'
import { companyFixture } from './test-fixture.ts'

/**
 * Integration against a real S3 server (MinIO). Runs when EE_TEST_S3_ENDPOINT
 * is set, e.g.:
 *   docker run -d --name k1-minio -p 9311:9000 -e MINIO_ROOT_USER=k1admin \
 *     -e MINIO_ROOT_PASSWORD=k1-secret-password cgr.dev/chainguard/minio@sha256:3c60a2a8… server /data
 *   EE_TEST_S3_ENDPOINT=http://127.0.0.1:9311 EE_TEST_S3_ACCESS_KEY=k1admin \
 *     EE_TEST_S3_SECRET_KEY=k1-secret-password npx vitest run src/backup/minio.spec.ts
 */
const endpoint = process.env.EE_TEST_S3_ENDPOINT
const run = endpoint ? describe : describe.skip

run('backups against a real S3 (MinIO)', () => {
  const target: S3Target = {
    endpoint: endpoint ?? 'http://unset',
    region: 'us-east-1',
    bucket: 'ee-backup-it',
    prefix: `run-${Date.now()}`,
    addressing: 'path',
    accessKeyId: process.env.EE_TEST_S3_ACCESS_KEY ?? '',
    secretAccessKey: process.env.EE_TEST_S3_SECRET_KEY ?? '',
  }
  beforeAll(async () => {
    await new S3Client(target).createBucket()
  })

  it('multipart with real 5 MiB parts round-trips', async () => {
    const s3 = new S3Client(target, { partSize: 5 * 1024 * 1024 })
    const big = randomBytes(11 * 1024 * 1024 + 3)
    await s3.upload(s3.key('mp/big'), Readable.from([big.subarray(0, 4_000_000), big.subarray(4_000_000)]))
    expect((await s3.getBuffer(s3.key('mp/big'))).equals(big)).toBe(true)
    await s3.deleteObject(s3.key('mp/big'))
  }, 60_000)

  it('snapshot → verify → restore fetch → retention, end to end', async () => {
    const co = await companyFixture()
    const sha = await co.addBlob(Buffer.from('minutes of the board meeting'))
    await co.addBlob(randomBytes(6 * 1024 * 1024))
    const s3 = new S3Client(target, { partSize: 5 * 1024 * 1024 })
    const key = newBackupKey()
    const a = await takeSnapshot(s3, key, co.sources, () => new Date('2026-09-01T03:00:00Z'))
    const b = await takeSnapshot(s3, key, co.sources, () => new Date('2026-11-02T03:00:00Z'))
    expect(b.blobsUploaded).toBe(0)
    await fetchSnapshot(s3, key, b.snapshotId, null)
    const out = join(co.root, 'restored')
    await fetchSnapshot(s3, key, b.snapshotId, { dir: out, driveDir: join(out, 'drive') })
    expect((await readFile(driveBlobPath(join(out, 'drive'), sha))).toString()).toBe('minutes of the board meeting')
    const p = await prune(s3, key, 30, new Date('2026-11-03T00:00:00Z'))
    expect(p.snapshotsDeleted).toEqual([a.snapshotId])
    expect((await listSnapshots(s3)).map((s) => s.id)).toEqual([b.snapshotId])
  }, 120_000)

  it('connection test: ok, and a plain error for wrong credentials', async () => {
    const svc = new BackupService({ now: () => new Date() } as never)
    expect(await svc.testConnection(target)).toEqual({ ok: true })
    const bad = await svc.testConnection({ ...target, secretAccessKey: 'wrong-wrong' })
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/403 SignatureDoesNotMatch/) })
  })
})
