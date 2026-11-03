import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newBackupKey } from './crypto.ts'
import { FakeS3 } from './fake-s3.ts'
import { S3Client } from './s3.ts'
import { driveBlobPath, fetchSnapshot, listSnapshots, prune, readManifest, resolveSnapshot, takeSnapshot } from './snapshot.ts'
import { companyFixture } from './test-fixture.ts'

const day = 86_400_000

describe('snapshots against the fake S3', () => {
  const fake = new FakeS3()
  let endpoint = ''
  beforeAll(async () => {
    endpoint = await fake.start()
  })
  afterAll(() => fake.stop())
  beforeEach(() => {
    fake.objects.clear()
    fake.log.length = 0
  })
  const key = newBackupKey()
  const at = (iso: string) => () => new Date(iso)

  it('uploads db, ee state, agent and blobs encrypted — the manifest last', async () => {
    const co = await companyFixture()
    const shas = [await co.addBlob(), await co.addBlob()]
    const s3 = new S3Client(fake.target(endpoint))
    const r = await takeSnapshot(s3, key, co.sources, at('2026-11-01T03:17:00Z'))
    expect(r.snapshotId).toBe('20261101T031700Z')
    expect(fake.keys()).toEqual(
      [
        ...shas.map((s) => `acme/blobs/${s}`).sort(),
        'acme/snapshots/20261101T031700Z/agent.sqlite',
        'acme/snapshots/20261101T031700Z/db.dump',
        'acme/snapshots/20261101T031700Z/ee-state.tar.gz',
        'acme/snapshots/20261101T031700Z/manifest.json',
      ].sort(),
    )
    const puts = fake.log.filter((l) => l.startsWith('PUT '))
    expect(puts.at(-1)).toBe('PUT acme/snapshots/20261101T031700Z/manifest.json')
    for (const [k, v] of fake.objects) {
      expect(v.subarray(0, 4).toString(), k).toBe('EEBK')
      expect(v.includes(Buffer.from('PGDMP-fake'))).toBe(false)
      expect(v.includes(Buffer.from('turn-1'))).toBe(false)
    }
    const m = await readManifest(s3, key, r.snapshotId)
    expect(m.blobs.map((b) => b.sha256)).toEqual([...shas].sort())
    expect(m.files.map((f) => f.name)).toEqual(['db.dump', 'ee-state.tar.gz', 'agent.sqlite'])
  })

  it('Drive blobs are incremental: the second run uploads only the new one', async () => {
    const co = await companyFixture()
    await co.addBlob()
    await co.addBlob()
    const s3 = new S3Client(fake.target(endpoint))
    const r1 = await takeSnapshot(s3, key, co.sources, at('2026-11-01T03:00:00Z'))
    expect(r1.blobsUploaded).toBe(2)
    const fresh = await co.addBlob()
    fake.log.length = 0
    const r2 = await takeSnapshot(s3, key, co.sources, at('2026-11-02T03:00:00Z'))
    expect(r2).toMatchObject({ blobsUploaded: 1, blobsTotal: 3 })
    expect(fake.log.filter((l) => l.startsWith('PUT acme/blobs/'))).toEqual([`PUT acme/blobs/${fresh}`])
  })

  it('a failing step leaves no manifest (the snapshot stays incomplete and is never restored)', async () => {
    const co = await companyFixture()
    const s3 = new S3Client(fake.target(endpoint))
    await expect(takeSnapshot(s3, key, { ...co.sources, dbDump: ['sh', '-c', 'echo "connection refused" >&2; exit 3'] }, at('2026-11-01T03:00:00Z'))).rejects.toThrow(/exit 3.*connection refused/)
    await co.addBlob()
    fake.failParts = 0
    const flaky = new S3Client(fake.target(endpoint), { partSize: 64 })
    fake.failParts = 1
    // (the 100-byte blob encrypts to >64 bytes, so it goes multipart and its first part fails)
    await expect(takeSnapshot(flaky, key, co.sources, at('2026-11-01T04:00:00Z'))).rejects.toThrow()
    fake.failParts = 0
    expect(fake.keys().filter((k) => k.endsWith('manifest.json'))).toEqual([])
    expect((await listSnapshots(s3)).every((s) => !s.complete)).toBe(true)
    await expect(resolveSnapshot(s3, 'latest')).rejects.toThrow(/no complete snapshot/)
  })

  it('a large object goes up as multipart and still round-trips', async () => {
    const co = await companyFixture()
    await co.addBlob(Buffer.alloc(3 * 1024 * 1024 + 17, 9))
    const s3 = new S3Client(fake.target(endpoint), { partSize: 1024 * 1024 })
    const r = await takeSnapshot(s3, key, co.sources, at('2026-11-01T03:00:00Z'))
    expect(fake.log.some((l) => l.endsWith('?uploads'))).toBe(true)
    await fetchSnapshot(s3, key, r.snapshotId, null)
  })

  it('restore fetch: every file and blob comes back byte-identical; agent.sqlite is a consistent copy', async () => {
    const co = await companyFixture()
    const sha = await co.addBlob(Buffer.from('a contract.pdf'))
    const s3 = new S3Client(fake.target(endpoint))
    const r = await takeSnapshot(s3, key, co.sources, at('2026-11-01T03:00:00Z'))
    const out = join(co.root, 'restore')
    const m = await fetchSnapshot(s3, key, r.snapshotId, { dir: out, driveDir: join(out, 'drive') })
    expect(m.id).toBe(r.snapshotId)
    expect((await readFile(join(out, 'db.dump'))).toString()).toBe('PGDMP-fake-company-dump')
    expect((await readFile(driveBlobPath(join(out, 'drive'), sha))).toString()).toBe('a contract.pdf')
    const db = new DatabaseSync(join(out, 'agent.sqlite'), { readOnly: true })
    expect(db.prepare('SELECT v FROM t ORDER BY v').all()).toEqual([{ v: 'turn-1' }, { v: 'turn-2' }])
    db.close()
    const listing = execFileSync('tar', ['-tzf', join(out, 'ee-state.tar.gz')]).toString()
    expect(listing).toMatch(/ee\/company\/desired\.json/)
    expect(listing).toMatch(/ee\/secrets\.enc/)
  })

  it('verify catches a tampered blob, a wrong key, and a missing blob', async () => {
    const co = await companyFixture()
    const sha = await co.addBlob()
    const s3 = new S3Client(fake.target(endpoint))
    const r = await takeSnapshot(s3, key, co.sources, at('2026-11-01T03:00:00Z'))
    await fetchSnapshot(s3, key, r.snapshotId, null)
    await expect(fetchSnapshot(s3, newBackupKey(), r.snapshotId, null)).rejects.toThrow(/authentication/)
    const k = `acme/blobs/${sha}`
    const orig = fake.objects.get(k)!
    const bad = Buffer.from(orig)
    bad[bad.length - 3]! ^= 0xff
    fake.objects.set(k, bad)
    await expect(fetchSnapshot(s3, key, r.snapshotId, null)).rejects.toThrow(/authentication/)
    fake.objects.delete(k)
    await expect(fetchSnapshot(s3, key, r.snapshotId, null)).rejects.toThrow(/NoSuchKey/)
  })

  it('retention: old snapshots and their unreferenced blobs go; the newest always stays; abandoned partial runs go', async () => {
    const co = await companyFixture()
    const s3 = new S3Client(fake.target(endpoint))
    const oldOnly = await co.addBlob()
    await takeSnapshot(s3, key, co.sources, at('2026-09-01T03:00:00Z'))
    // The old-only blob leaves Drive (file deleted), so later snapshots don't reference it.
    const { rm } = await import('node:fs/promises')
    await rm(driveBlobPath(co.sources.driveDir, oldOnly))
    const shared = await co.addBlob()
    await takeSnapshot(s3, key, co.sources, at('2026-10-20T03:00:00Z'))
    await takeSnapshot(s3, key, co.sources, at('2026-11-02T03:00:00Z'))
    // An abandoned partial run from 3 days ago (no manifest).
    await s3.putObject(s3.key('snapshots/20261031T030000Z/db.dump'), Buffer.from('x'))
    const res = await prune(s3, key, 30, new Date('2026-11-03T03:00:00Z'))
    expect(res.snapshotsDeleted.sort()).toEqual(['20260901T030000Z', '20261031T030000Z'])
    expect(res.blobsDeleted).toBe(1)
    expect(fake.keys('acme/blobs/')).toEqual([`acme/blobs/${shared}`])
    expect((await listSnapshots(s3)).map((s) => s.id)).toEqual(['20261020T030000Z', '20261102T030000Z'])
    // Retention never empties the bucket: a lone old snapshot stays.
    const res2 = await prune(s3, key, 1, new Date('2027-06-01T00:00:00Z'))
    expect(res2.snapshotsDeleted).toEqual(['20261020T030000Z'])
    expect(await resolveSnapshot(s3, 'latest')).toBe('20261102T030000Z')
    expect(fake.keys('acme/blobs/')).toEqual([`acme/blobs/${shared}`])
  })

  it('a manifest that cannot be read stops the blob sweep (never deletes what it cannot prove unreferenced)', async () => {
    const co = await companyFixture()
    await co.addBlob()
    const s3 = new S3Client(fake.target(endpoint))
    await takeSnapshot(s3, key, co.sources, at('2026-11-01T03:00:00Z'))
    const before = fake.keys('acme/blobs/')
    await expect(prune(s3, newBackupKey(), 30, new Date('2026-11-02T00:00:00Z'))).rejects.toThrow(/authentication/)
    expect(fake.keys('acme/blobs/')).toEqual(before)
  })
})
