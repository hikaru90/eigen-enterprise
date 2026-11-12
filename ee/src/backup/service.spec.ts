import type { SecretMap } from '../secrets.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { backupRoute } from './control.ts'
import { backupKeyFromRecoveryCode, companyRecoveryCode } from './crypto.ts'
import { FakeS3 } from './fake-s3.ts'
import { BackupService, MISSING_AFTER_MS } from './service.ts'
import { readManifest } from './snapshot.ts'
import { companyFixture } from './test-fixture.ts'

async function harness(endpoint: string, fake: FakeS3) {
  const co = await companyFixture()
  let data: SecretMap = {}
  const files = new Map<string, string>()
  const events: Array<{ type: string; message: string }> = []
  const schedules: Array<{ hour: number; minute: number }> = []
  let clock = new Date('2026-11-01T10:00:00Z')
  const svc = new BackupService({
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
    applySchedule: async (s) => void schedules.push(s),
    busy: () => null,
  })
  const target = fake.target(endpoint)
  return { svc, co, events, schedules, files, target, secrets: () => data, setClock: (d: Date) => (clock = d) }
}

describe('BackupService', () => {
  const fake = new FakeS3()
  let endpoint = ''
  beforeAll(async () => {
    endpoint = await fake.start()
  })
  afterAll(() => fake.stop())

  it('test connection: ok against a working bucket, a plain error otherwise; nothing is saved', async () => {
    const h = await harness(endpoint, fake)
    expect(await h.svc.testConnection(h.target)).toEqual({ ok: true })
    const bad = await h.svc.testConnection({ ...h.target, secretAccessKey: 'wrong' })
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/SignatureDoesNotMatch/) })
    expect(h.secrets()).toEqual({})
    expect(fake.keys().filter((k) => k.includes('.ee-connection-test'))).toEqual([])
  })

  it('first save seals the backup key the app derived from the company recovery code; ee never returns a code', async () => {
    const h = await harness(endpoint, fake)
    await expect(h.svc.configure({ target: h.target, schedule: { hour: 2 }, retentionDays: 30, author: 'owner:ada' })).rejects.toMatchObject({ status: 400 })
    const code = companyRecoveryCode(Buffer.alloc(32, 9))
    const backupKey = backupKeyFromRecoveryCode(code).toString('base64')
    const first = await h.svc.configure({ target: h.target, schedule: { hour: 2 }, retentionDays: 30, backupKey, author: 'owner:ada' })
    expect(first).not.toHaveProperty('recoveryCode')
    expect(h.svc.key()!.toString('base64')).toBe(backupKey)
    expect(h.schedules[0]!.hour).toBe(2)
    // Status never carries the secret key or the backup key.
    const status = JSON.stringify(await h.svc.status())
    expect(status).not.toContain(h.target.secretAccessKey)
    expect(status).not.toContain(backupKey)
    // Edit: no secret, no key needed again; same minute.
    const { secretAccessKey: _s, ...noSecret } = h.target
    const second = await h.svc.configure({ target: noSecret, schedule: { hour: 4 }, retentionDays: 7, author: 'owner:ada' })
    expect(h.schedules[1]).toEqual({ hour: 4, minute: h.schedules[0]!.minute })
    expect(second.config.retentionDays).toBe(7)
    // A different key would orphan every snapshot: refused.
    const other = backupKeyFromRecoveryCode(companyRecoveryCode(Buffer.alloc(32, 1))).toString('base64')
    await expect(h.svc.configure({ target: noSecret, schedule: { hour: 4 }, retentionDays: 7, backupKey: other, author: 'owner:ada' })).rejects.toMatchObject({ status: 409 })
    expect(h.svc.key()!.toString('base64')).toBe(backupKey)
  })

  it('a failing connection test refuses the save', async () => {
    const h = await harness(endpoint, fake)
    await expect(h.svc.configure({ target: { ...h.target, secretAccessKey: 'wrong' }, schedule: { hour: 2 }, retentionDays: 30, author: 'owner:ada' })).rejects.toMatchObject({ status: 422 })
    expect(h.svc.config()).toBeNull()
    expect(h.svc.key()).toBeNull()
  })

  it('a run records size/duration/result, emits events, and health follows it (ok → failed → missing)', async () => {
    const h = await harness(endpoint, fake)
    h.target.prefix = 'svc' // its own prefix: other tests' snapshots don't count
    await h.co.addBlob()
    expect((await h.svc.status()).health).toEqual({ state: 'unconfigured' })
    await h.svc.configure({ target: h.target, schedule: { hour: 2 }, retentionDays: 30, backupKey: backupKeyFromRecoveryCode(companyRecoveryCode(Buffer.alloc(32, 9))).toString('base64'), author: 'owner:ada' })
    const { run, done } = await h.svc.start('manual', 'owner:ada')
    expect(run.status).toBe('running')
    await expect(h.svc.start('manual', 'owner:ada')).rejects.toMatchObject({ status: 409 })
    const r = await done
    expect(r).toMatchObject({ status: 'succeeded', blobsUploaded: 1, blobsTotal: 1, error: null })
    expect(r.bytesUploaded).toBeGreaterThan(0)
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
    expect((await readManifest(h.svc.client(h.svc.config()!.target), h.svc.key()!, r.snapshotId!)).id).toBe(r.snapshotId)
    expect(h.events.map((e) => e.type)).toEqual(['backup.configured', 'backup.started', 'backup.succeeded'])
    expect((await h.svc.status()).health).toMatchObject({ state: 'ok' })

    // A failed run: health is failed, with the plain cause.
    const real = h.svc as unknown as { d: { sources: { dbDump: string[] } } }
    const saved = real.d.sources.dbDump
    real.d.sources.dbDump = ['sh', '-c', 'echo "pg_dump: connection refused" >&2; exit 1']
    const failed = await (await h.svc.start('scheduled', 'ee-timer')).done
    expect(failed).toMatchObject({ status: 'failed', error: expect.stringMatching(/connection refused/) })
    expect((await h.svc.status()).health).toMatchObject({ state: 'failed', error: expect.stringMatching(/connection refused/) })
    expect(h.events.at(-1)!.type).toBe('backup.failed')
    real.d.sources.dbDump = saved

    // Success again, then nothing for > 26h: missing.
    await (await h.svc.start('scheduled', 'ee-timer')).done
    h.setClock(new Date(Date.parse('2026-11-01T10:00:00Z') + MISSING_AFTER_MS + 60_000))
    expect((await h.svc.status()).health).toMatchObject({ state: 'missing' })
    const runs = (await h.svc.status()).runs
    expect(runs.map((x) => x.status)).toEqual(['succeeded', 'failed', 'succeeded'])
    // Records persist in the runs file.
    expect(JSON.parse(h.files.get('/runs.json')!).runs).toHaveLength(3)
  })

  it('control routes: scheduled runs on an unconfigured box are skipped, manual ones refused plainly', async () => {
    const h = await harness(endpoint, fake)
    const body = (b: unknown) => async () => b
    expect(await backupRoute(h.svc, 'POST /v1/backups/run', body({ author: 'ee-timer', trigger: 'scheduled', wait: true }))).toEqual({ status: 200, data: { skipped: 'backups are not set up' } })
    expect(await backupRoute(h.svc, 'POST /v1/backups/run', body({ author: 'owner:ada' }))).toMatchObject({ status: 409 })
    expect(await backupRoute(h.svc, 'GET /v1/backups', body({}))).toMatchObject({ status: 200, data: { configured: false } })
    expect(await backupRoute(h.svc, 'POST /v1/backups/test', body({ target: h.target }))).toEqual({ status: 200, data: { ok: true } })
    expect(await backupRoute(h.svc, 'GET /v1/nope', body({}))).toBeNull()
    const saved = await backupRoute(h.svc, 'POST /v1/backups/config', body({ target: h.target, schedule: { hour: 1 }, retentionDays: 14, backupKey: backupKeyFromRecoveryCode(companyRecoveryCode(Buffer.alloc(32, 9))).toString('base64'), author: 'owner:ada' }))
    expect(saved).toMatchObject({ status: 200, data: { config: { configured: true } } })
    const ran = await backupRoute(h.svc, 'POST /v1/backups/run', body({ author: 'owner:ada', wait: true }))
    expect(ran).toMatchObject({ status: 200, data: { run: { status: 'succeeded' } } })
  })

  it('a run left "running" by a crashed process reads as failed after a restart', async () => {
    const h = await harness(endpoint, fake)
    h.files.set('/runs.json', JSON.stringify({ version: 1, runs: [{ id: 'x', trigger: 'scheduled', author: 'ee-timer', status: 'running', startedAt: '2026-11-01T03:00:00Z', endedAt: null, durationMs: null, snapshotId: null, bytesUploaded: null, snapshotSize: null, blobsUploaded: null, blobsTotal: null, pruned: null, error: null }] }))
    expect((await h.svc.status()).runs[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/ee stopped/) })
  })
})
