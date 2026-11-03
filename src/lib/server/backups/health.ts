import { createHash } from 'node:crypto'
import type { BackupRun, BackupStatus } from '$lib/server/ee/client'

/**
 * Backup health as the company sees it (plan/phase-backups.md §2 Health):
 * ee records every run; the app mirrors finished runs into kernel_events,
 * puts a failed or missing nightly run on Overview → Needs you, and pushes
 * the owner once per incident.
 */

export type BackupNotice = { kind: 'failed' | 'missing'; text: string; href: '/settings/backups' }

/** What Overview shows the owner, or null when nothing needs them. */
export function backupNotice(status: BackupStatus): BackupNotice | null {
  const h = status.health
  if (h.state === 'failed') return { kind: 'failed', text: `The last backup failed: ${h.error}`, href: '/settings/backups' }
  if (h.state === 'missing') return { kind: 'missing', text: `No backup ran last night — ${h.message}`, href: '/settings/backups' }
  return null
}

/** A stable UUID for a key, so a mirrored event or a sent alert is recorded exactly once. */
export function stableEventId(key: string): string {
  const h = createHash('sha256').update(key).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** The one key per incident: a failed run, or the missing night since the last success. */
export function incidentKey(status: BackupStatus): string | null {
  const h = status.health
  if (h.state === 'failed') return `backup.alert:failed:${status.runs.find((r) => r.status === 'failed')?.id ?? h.at}`
  if (h.state === 'missing') return `backup.alert:missing:${h.lastSuccessAt ?? status.configuredAt ?? 'never'}`
  return null
}

export type BackupHealthDeps = {
  status(): Promise<BackupStatus | null> // null: not running under ee
  hasEvent(id: string): Promise<boolean>
  emit(e: { id: string; type: string; payload: Record<string, unknown> }): Promise<void>
  ownerId(): Promise<string | null>
  push(userId: string, p: { title: string; body: string; url: string; tag: string }): Promise<void>
}

export type BackupHealthTick =
  | { managed: false }
  | { managed: true; mirrored: number; alerted: string | null; alertError: string | null }

const finished = (r: BackupRun) => r.status !== 'running'

export async function tickBackupHealth(d: BackupHealthDeps): Promise<BackupHealthTick> {
  const status = await d.status()
  if (!status) return { managed: false }
  let mirrored = 0
  for (const run of [...status.runs].reverse().filter(finished)) {
    const id = stableEventId(`backup.run:${run.id}`)
    if (await d.hasEvent(id)) continue
    await d.emit({
      id,
      type: run.status === 'succeeded' ? 'backup.run_succeeded' : 'backup.run_failed',
      payload: {
        runId: run.id,
        trigger: run.trigger,
        snapshotId: run.snapshotId,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        durationMs: run.durationMs,
        bytesUploaded: run.bytesUploaded,
        error: run.error,
      },
    })
    mirrored++
  }
  const key = incidentKey(status)
  const notice = backupNotice(status)
  if (!key || !notice) return { managed: true, mirrored, alerted: null, alertError: null }
  const alertId = stableEventId(key)
  if (await d.hasEvent(alertId)) return { managed: true, mirrored, alerted: null, alertError: null }
  const owner = await d.ownerId()
  let alertError: string | null = null
  if (owner) {
    try {
      await d.push(owner, {
        title: notice.kind === 'failed' ? 'Backup failed' : 'Backup missing',
        body: notice.text.slice(0, 140),
        url: notice.href,
        tag: 'backup-health',
      })
    } catch (err) {
      // No subscription is a legit state (the notice is on Overview); recorded, not retried.
      alertError = err instanceof Error ? err.message : String(err)
    }
  } else alertError = 'the company has no owner yet'
  await d.emit({ id: alertId, type: 'backup.alert', payload: { key, kind: notice.kind, text: notice.text, ownerId: owner, pushError: alertError } })
  return { managed: true, mirrored, alerted: key, alertError }
}
