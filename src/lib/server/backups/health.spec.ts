import { describe, expect, it } from 'vitest'
import type { BackupRun, BackupStatus } from '$lib/server/ee/client'
import { backupNotice, stableEventId, tickBackupHealth, type BackupHealthDeps } from './health'

const run = (over: Partial<BackupRun>): BackupRun => ({
  id: 'r1',
  trigger: 'scheduled',
  author: 'ee-timer',
  status: 'succeeded',
  startedAt: '2026-11-02T03:12:00.000Z',
  endedAt: '2026-11-02T03:13:00.000Z',
  durationMs: 60_000,
  snapshotId: '20261102T031200Z',
  bytesUploaded: 1000,
  snapshotSize: 900,
  blobsUploaded: 1,
  blobsTotal: 1,
  pruned: { snapshots: 0, blobs: 0 },
  error: null,
  ...over,
})

const status = (over: Partial<BackupStatus>): BackupStatus => ({
  configured: true,
  target: null,
  schedule: { hour: 3, minute: 12 },
  retentionDays: 30,
  configuredAt: '2026-11-01T10:00:00.000Z',
  keyCreatedAt: '2026-11-01T10:00:00.000Z',
  health: { state: 'ok', lastSuccessAt: '2026-11-02T03:13:00.000Z' },
  runs: [run({})],
  ...over,
})

function deps(s: BackupStatus | null, opts: { owner?: string | null; pushFails?: boolean } = {}) {
  const events = new Map<string, { type: string; payload: Record<string, unknown> }>()
  const pushes: Array<{ userId: string; title: string; body: string }> = []
  const d: BackupHealthDeps = {
    status: async () => s,
    hasEvent: async (id) => events.has(id),
    emit: async (e) => void events.set(e.id, e),
    ownerId: async () => (opts.owner === undefined ? 'owner-1' : opts.owner),
    push: async (userId, p) => {
      if (opts.pushFails) throw new Error('No push subscriptions registered for this account')
      pushes.push({ userId, title: p.title, body: p.body })
    },
  }
  return { d, events, pushes }
}

describe('backup health', () => {
  it('Overview notice only for a failed or missing night', () => {
    expect(backupNotice(status({}))).toBeNull()
    expect(backupNotice(status({ health: { state: 'unconfigured' } }))).toBeNull()
    expect(backupNotice(status({ health: { state: 'running', since: 'x' } }))).toBeNull()
    expect(backupNotice(status({ health: { state: 'failed', at: 'x', error: 'S3 PUT failed: 403' } }))).toEqual({
      kind: 'failed',
      text: 'The last backup failed: S3 PUT failed: 403',
      href: '/settings/backups',
    })
    expect(backupNotice(status({ health: { state: 'missing', lastSuccessAt: null, message: 'no backup has run since x' } }))?.kind).toBe('missing')
  })

  it('stable ids are UUIDs and stable', () => {
    expect(stableEventId('a')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(stableEventId('a')).toBe(stableEventId('a'))
    expect(stableEventId('a')).not.toBe(stableEventId('b'))
  })

  it('not under ee: nothing to do', async () => {
    expect(await tickBackupHealth(deps(null).d)).toEqual({ managed: false })
  })

  it('mirrors each finished run into kernel_events once; a running one waits', async () => {
    const s = status({ runs: [run({ id: 'r3', status: 'running', endedAt: null }), run({ id: 'r2', status: 'failed', error: 'boom' }), run({ id: 'r1' })] })
    const h = deps(s)
    expect(await tickBackupHealth(h.d)).toMatchObject({ mirrored: 2, alerted: null })
    expect([...h.events.values()].map((e) => e.type)).toEqual(['backup.run_succeeded', 'backup.run_failed'])
    expect(await tickBackupHealth(h.d)).toMatchObject({ mirrored: 0 })
  })

  it('a failed night pushes the owner exactly once per incident', async () => {
    const s = status({ health: { state: 'failed', at: 't', error: 'pg_dump: connection refused' }, runs: [run({ id: 'r9', status: 'failed', error: 'pg_dump: connection refused' })] })
    const h = deps(s)
    const first = await tickBackupHealth(h.d)
    expect(first).toMatchObject({ alerted: 'backup.alert:failed:r9', alertError: null })
    expect(h.pushes).toEqual([{ userId: 'owner-1', title: 'Backup failed', body: 'The last backup failed: pg_dump: connection refused' }])
    await tickBackupHealth(h.d)
    expect(h.pushes).toHaveLength(1)
    expect([...h.events.values()].filter((e) => e.type === 'backup.alert')).toHaveLength(1)
  })

  it('a missing night alerts; an owner without push still gets the alert recorded (and the Overview notice)', async () => {
    const s = status({ health: { state: 'missing', lastSuccessAt: '2026-11-01T03:13:00.000Z', message: 'no backup has run since 2026-11-01T03:13:00.000Z' } })
    const h = deps(s, { pushFails: true })
    const r = await tickBackupHealth(h.d)
    expect(r).toMatchObject({ alerted: 'backup.alert:missing:2026-11-01T03:13:00.000Z', alertError: expect.stringMatching(/No push subscriptions/) })
    const alert = [...h.events.values()].find((e) => e.type === 'backup.alert')!
    expect(alert.payload).toMatchObject({ kind: 'missing', pushError: expect.stringMatching(/No push/) })
  })
})
