import type { SecretMap } from '../secrets.ts'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { restoreRoute } from './control.ts'
import { backupKeyFromRecoveryCode, companyRecoveryCode } from './crypto.ts'
import { FakeS3 } from './fake-s3.ts'
import { RestoreService, restoreWorkDir, runApply, type RestoreJob } from './restore.ts'
import { BackupService } from './service.ts'
import { companyFixture } from './test-fixture.ts'

const CODE = companyRecoveryCode(Buffer.alloc(32, 9))
const KEY = backupKeyFromRecoveryCode(CODE).toString('base64')
const OTHER_KEY = backupKeyFromRecoveryCode(companyRecoveryCode(Buffer.alloc(32, 1))).toString('base64')

let prefixes = 0

async function harness(endpoint: string, fake: FakeS3) {
  const co = await companyFixture()
  let data: SecretMap = {}
  const files = new Map<string, string>()
  const events: Array<{ type: string; message: string }> = []
  const launched: string[] = []
  let unitActive = false
  let launchFails: Error | null = null
  const clock = new Date('2026-11-01T10:00:00Z')
  const stagingDir = await mkdtemp(join(tmpdir(), 'ee-restore-staging-'))
  const ref: { restore?: RestoreService } = {}
  const backups = new BackupService({
    secrets: {
      all: () => data,
      set: async (w, n, v) => {
        data = { ...data, [w]: { ...(data[w] ?? {}), [n]: v } }
      },
    },
    readFile: async (p) => files.get(p) ?? null,
    writeFile: async (p, c) => void files.set(p, c),
    runsFile: '/runs.json',
    sources: co.sources,
    now: () => clock,
    emit: async (type, message) => void events.push({ type, message }),
    applySchedule: async () => undefined,
    busy: () => ref.restore!.busyNow(),
  })
  const restore = (ref.restore = new RestoreService({
    backups,
    readFile: async (p) => files.get(p) ?? null,
    writeFile: async (p, c) => void files.set(p, c),
    stateFile: '/restore.json',
    stagingDir,
    now: () => clock,
    emit: async (type, message) => void events.push({ type, message }),
    launchApply: async (id) => {
      if (launchFails) throw launchFails
      launched.push(id)
      unitActive = true
    },
    applyActive: async () => unitActive,
  }))
  const target = { ...fake.target(endpoint), prefix: `restore-${++prefixes}` }
  await co.addBlob()
  await backups.configure({ target, schedule: { hour: 2 }, retentionDays: 30, backupKey: KEY, author: 'owner:ada' })
  const snap = (await (await backups.start('manual', 'owner:ada')).done).snapshotId!
  return {
    co,
    backups,
    restore,
    events,
    files,
    launched,
    stagingDir,
    snap,
    target,
    setUnitActive: (v: boolean) => (unitActive = v),
    setLaunchFails: (e: Error | null) => (launchFails = e),
    stored: () => JSON.parse(files.get('/restore.json')!).job as RestoreJob,
  }
}

describe('RestoreService (Settings → Backups: check and restore through ee)', () => {
  const fake = new FakeS3()
  let endpoint = ''
  beforeAll(async () => {
    endpoint = await fake.start()
  })
  afterAll(() => fake.stop())

  it('lists the complete snapshots in the bucket, newest first', async () => {
    const h = await harness(endpoint, fake)
    // A run that never wrote its manifest: listed objects, but not a snapshot you can use.
    fake.objects.set(`${h.target.prefix}/snapshots/20261101T090000Z/db.dump`, Buffer.from('x'))
    const { snapshots } = await h.restore.snapshots()
    expect(snapshots).toEqual([{ id: h.snap, takenAt: '2026-11-01T10:00:00.000Z' }])
  })

  it('check: downloads, decrypts and hashes every file and blob, records what it checked, writes nothing', async () => {
    const h = await harness(endpoint, fake)
    const { job, done } = await h.restore.check({ snapshotId: h.snap, author: 'human:u-owner' })
    expect(job).toMatchObject({ kind: 'check', status: 'running', step: 'verifying', snapshotId: h.snap })
    const r = await done
    expect(r).toMatchObject({ kind: 'check', status: 'succeeded', error: null })
    expect(r.checked).toEqual({
      files: [
        { name: 'db.dump', size: expect.any(Number) },
        { name: 'ee-state.tar.gz', size: expect.any(Number) },
        { name: 'agent.sqlite', size: expect.any(Number) },
      ],
      blobs: 1,
      blobBytes: 100,
    })
    expect(await readdir(h.stagingDir)).toEqual([])
    expect(h.launched).toEqual([])
    expect(h.stored()).toMatchObject({ id: r.id, status: 'succeeded' })
    expect(h.events.map((e) => e.type)).toContain('backup.checked')
  })

  it('check: a tampered object fails with the plain cause', async () => {
    const h = await harness(endpoint, fake)
    const k = `${h.target.prefix}/snapshots/${h.snap}/db.dump`
    const obj = Buffer.from(fake.objects.get(k)!)
    obj[obj.length - 3]! ^= 0xff
    fake.objects.set(k, obj)
    const r = await (await h.restore.check({ snapshotId: h.snap, author: 'human:u-owner' })).done
    expect(r).toMatchObject({ status: 'failed', error: expect.stringMatching(/./) })
    expect(h.events.map((e) => e.type)).toContain('backup.check_failed')
  })

  it('check: an unknown or incomplete snapshot fails plainly', async () => {
    const h = await harness(endpoint, fake)
    const r = await (await h.restore.check({ snapshotId: '20200101T000000Z', author: 'human:u-owner' })).done
    expect(r).toMatchObject({ status: 'failed', error: expect.stringMatching(/no snapshot 20200101T000000Z/) })
  })

  it('one job at a time: no check or restore while a backup runs, no backup while a check runs', async () => {
    const h = await harness(endpoint, fake)
    const run = await h.backups.start('manual', 'owner:ada')
    await expect(h.restore.check({ snapshotId: h.snap, author: 'human:u-owner' })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/backup is running/) })
    await expect(h.restore.restore({ snapshotId: h.snap, backupKey: KEY, author: 'human:u-owner' })).rejects.toMatchObject({ status: 409 })
    await run.done
    const c = await h.restore.check({ snapshotId: h.snap, author: 'human:u-owner' })
    await expect(h.backups.start('manual', 'owner:ada')).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/check/) })
    await expect(h.restore.check({ snapshotId: h.snap, author: 'human:u-owner' })).rejects.toMatchObject({ status: 409 })
    await c.done
    expect(await h.restore.busy()).toBeNull()
  })

  it('restore: a recovery code of another company is refused before anything starts', async () => {
    const h = await harness(endpoint, fake)
    await expect(h.restore.restore({ snapshotId: h.snap, backupKey: OTHER_KEY, author: 'human:u-owner' })).rejects.toMatchObject({ status: 422 })
    expect(h.files.has('/restore.json')).toBe(false)
    expect(h.launched).toEqual([])
    // and nothing stays claimed
    expect(await h.restore.busy()).toBeNull()
  })

  it('restore: verifies into the staging dir, then hands over to the restore unit; the key is never written', async () => {
    const h = await harness(endpoint, fake)
    const { job, done } = await h.restore.restore({ snapshotId: h.snap, backupKey: KEY, author: 'human:u-owner' })
    expect(job).toMatchObject({ kind: 'restore', status: 'running', step: 'verifying' })
    const r = await done
    expect(r).toMatchObject({ status: 'running', step: 'handover', error: null })
    expect(r.checked?.blobs).toBe(1)
    expect(h.launched).toEqual([h.snap])
    const work = restoreWorkDir(h.stagingDir, h.snap)
    expect((await readdir(work)).sort()).toEqual(['agent.sqlite', 'db.dump', 'drive', 'ee-state.tar.gz'])
    expect((await readFile(join(work, 'db.dump'))).toString()).toBe('PGDMP-fake-company-dump')
    for (const [, v] of h.files) expect(v).not.toContain(KEY)
    expect(JSON.stringify(h.events)).not.toContain(KEY)
    expect(h.events.map((e) => e.type)).toContain('restore.started')
    // While the unit runs, everything else is refused — another restore, a check, a backup.
    await expect(h.restore.restore({ snapshotId: h.snap, backupKey: KEY, author: 'human:u-owner' })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/restore is running/) })
    await expect(h.restore.check({ snapshotId: h.snap, author: 'human:u-owner' })).rejects.toMatchObject({ status: 409 })
    await expect(h.backups.start('manual', 'owner:ada')).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/restore/) })
  })

  it('restore: a snapshot that fails verification never reaches the box', async () => {
    const h = await harness(endpoint, fake)
    const k = `${h.target.prefix}/snapshots/${h.snap}/ee-state.tar.gz`
    const obj = Buffer.from(fake.objects.get(k)!)
    obj[50]! ^= 0x01
    fake.objects.set(k, obj)
    const r = await (await h.restore.restore({ snapshotId: h.snap, backupKey: KEY, author: 'human:u-owner' })).done
    expect(r).toMatchObject({ status: 'failed', step: 'verifying' })
    expect(r.error).toMatch(/nothing on this server was changed/)
    expect(h.launched).toEqual([])
    expect(await readdir(h.stagingDir)).toEqual([])
  })

  it('restore: the unit failing to start is a plain failure, staging cleaned', async () => {
    const h = await harness(endpoint, fake)
    h.setLaunchFails(new Error('systemd-run: Unit ee-restore.service already exists'))
    const r = await (await h.restore.restore({ snapshotId: h.snap, backupKey: KEY, author: 'human:u-owner' })).done
    expect(r).toMatchObject({ status: 'failed', error: expect.stringMatching(/already exists/) })
    expect(await readdir(h.stagingDir)).toEqual([])
  })

  it('after a restart: a check cut off reads as failed; a dead restore unit reads as failed; a finished restore is announced once', async () => {
    const h = await harness(endpoint, fake)
    const base = { id: 'j1', kind: 'check', snapshotId: h.snap, author: 'human:u-owner', status: 'running', step: 'verifying', startedAt: '2026-11-01T09:00:00.000Z', updatedAt: '2026-11-01T09:00:00.000Z', endedAt: null, checked: null, error: null, log: [], announced: false }
    h.files.set('/restore.json', JSON.stringify({ version: 1, job: base }))
    expect(await h.restore.job()).toMatchObject({ status: 'failed', error: expect.stringMatching(/ee stopped/) })

    h.files.set('/restore.json', JSON.stringify({ version: 1, job: { ...base, kind: 'restore', step: 'handover' } }))
    h.setUnitActive(false)
    expect(await h.restore.job()).toMatchObject({ status: 'failed', error: expect.stringMatching(/did not start.*nothing on this server was changed/) })

    h.files.set('/restore.json', JSON.stringify({ version: 1, job: { ...base, kind: 'restore', step: 'restoring-database' } }))
    expect(await h.restore.job()).toMatchObject({ status: 'failed', error: expect.stringMatching(/partly restored/) })

    h.files.set('/restore.json', JSON.stringify({ version: 1, job: { ...base, kind: 'restore', step: 'starting' } }))
    h.setUnitActive(true)
    expect(await h.restore.job()).toMatchObject({ status: 'running', step: 'starting' })

    const n = h.events.length
    h.files.set('/restore.json', JSON.stringify({ version: 1, job: { ...base, kind: 'restore', status: 'succeeded', step: 'done', endedAt: '2026-11-01T09:10:00.000Z' } }))
    expect(await h.restore.job()).toMatchObject({ status: 'succeeded', announced: true })
    await h.restore.job()
    expect(h.events.slice(n).map((e) => e.type)).toEqual(['restore.succeeded'])
  })

  it('control routes: snapshots, job status, check, restore; refusals are problem replies', async () => {
    const h = await harness(endpoint, fake)
    const body = (b: unknown) => async () => b
    expect(await restoreRoute(h.restore, 'GET /v1/backups/snapshots', body(null))).toMatchObject({ status: 200, data: { snapshots: [{ id: h.snap }] } })
    expect(await restoreRoute(h.restore, 'GET /v1/backups/restore', body(null))).toEqual({ status: 200, data: { job: null } })
    const c = await restoreRoute(h.restore, 'POST /v1/backups/check', body({ snapshotId: h.snap, author: 'human:u-owner' }))
    expect(c).toMatchObject({ status: 202, data: { job: { kind: 'check', status: 'running' } } })
    expect(await restoreRoute(h.restore, 'POST /v1/backups/check', body({ snapshotId: h.snap, author: 'human:u-owner' }))).toMatchObject({ status: 409, data: { type: 'urn:ee:backup' } })
    await h.restore.idle()
    const wrong = await restoreRoute(h.restore, 'POST /v1/backups/restore', body({ snapshotId: h.snap, backupKey: OTHER_KEY, author: 'human:u-owner' }))
    expect(wrong).toMatchObject({ status: 422, data: { detail: expect.stringMatching(/recovery code/) } })
    await expect(restoreRoute(h.restore, 'POST /v1/backups/restore', body({ snapshotId: '../etc', backupKey: KEY, author: 'x' }))).rejects.toThrow()
    expect(await restoreRoute(h.restore, 'GET /v1/backups', body(null))).toBeNull()
  })
})

describe('runApply (the ee-restore.service side)', () => {
  const job = (over: Partial<RestoreJob> = {}): RestoreJob => ({
    id: 'j1',
    kind: 'restore',
    snapshotId: '20261101T100000Z',
    author: 'human:u-owner',
    status: 'running',
    step: 'handover',
    startedAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    endedAt: null,
    checked: { files: [], blobs: 0, blobBytes: 0 },
    error: null,
    log: [],
    announced: false,
    ...over,
  })
  function deps(initial: RestoreJob | null) {
    const files = new Map<string, string>()
    if (initial) files.set('/restore.json', JSON.stringify({ version: 1, job: initial }))
    const started: string[] = []
    return {
      files,
      started,
      d: {
        readFile: async (p: string) => files.get(p) ?? null,
        writeFile: async (p: string, c: string) => void files.set(p, c),
        stateFile: '/restore.json',
        now: () => new Date('2026-11-01T10:05:00Z'),
        startEe: async () => void started.push('ee.service'),
      },
      read: () => JSON.parse(files.get('/restore.json')!).job as RestoreJob,
    }
  }

  it('refuses unless that snapshot was verified and handed over by ee', async () => {
    for (const j of [null, job({ step: 'verifying' }), job({ snapshotId: '20261102T100000Z' }), job({ status: 'failed' }), job({ kind: 'check' })]) {
      const x = deps(j)
      await expect(runApply(x.d, '20261101T100000Z', async () => undefined, () => undefined)).rejects.toThrow(/no restore of 20261101T100000Z is waiting/)
      expect(x.started).toEqual([])
    }
  })

  it('records every step, then done', async () => {
    const x = deps(job())
    const seen: string[] = []
    await runApply(
      x.d,
      '20261101T100000Z',
      async (progress) => {
        await progress('stopping', '→ stopping ee and the workloads')
        seen.push(x.read().step)
        await progress('restoring-database', '→ restoring the company database (os)')
        seen.push(x.read().step)
        await progress('starting', '→ starting ee')
      },
      () => undefined,
    )
    expect(seen).toEqual(['stopping', 'restoring-database'])
    expect(x.read()).toMatchObject({ status: 'succeeded', step: 'done', endedAt: '2026-11-01T10:05:00.000Z' })
    expect(x.read().log).toEqual(['→ stopping ee and the workloads', '→ restoring the company database (os)', '→ starting ee', '✓ restored backup 20261101T100000Z'])
  })

  it('a failure is recorded and ee is started again so the page can show it', async () => {
    const x = deps(job())
    await expect(
      runApply(
        x.d,
        '20261101T100000Z',
        async (progress) => {
          await progress('restoring-database', '→ restoring the company database (os)')
          throw new Error('pg_restore failed (exit 1): out of disk')
        },
        () => undefined,
      ),
    ).rejects.toThrow(/out of disk/)
    expect(x.read()).toMatchObject({ status: 'failed', step: 'restoring-database', error: expect.stringMatching(/out of disk/) })
    expect(x.started).toEqual(['ee.service'])
  })
})
