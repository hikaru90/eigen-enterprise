import type { Actions, PageServerLoad } from './$types'
import { fail } from '@sveltejs/kit'
import { requireCapability } from '$lib/server/auth/require-capability'
import {
  backupKeyFromRecoveryCode,
  companyBackupKey,
  type BackupKeyMaterial,
} from '$lib/server/backups/company-key'
import {
  BACKUP_SNAPSHOT_ID,
  EeClient,
  SubstrateError,
  SubstrateUnavailableError,
  type BackupSnapshot,
  type BackupStatus,
  type BackupTarget,
  type RestoreJob,
} from '$lib/server/ee/client'

/**
 * Settings → Backups (plan/phase-backups.md K2): the owner sets up the bucket,
 * keeps the recovery code, chooses schedule + retention, runs a backup now
 * and sees the last runs. Owner only — it is a server change (D11) and the
 * recovery code unlocks every backup. The person clicking is the decision, so
 * this page calls ee directly; the agent only has the read-only status tool.
 *
 * It also lists the backups in the bucket: "Check" asks ee to download,
 * decrypt and hash one (writes nothing); "Restore…" opens the restore screen
 * (./restore/[snapshot]). ee does both — the console never restores itself.
 */

/** The bucket listing: ee lists it live, so a bucket error is shown, not hidden. */
export type SnapshotList = { ok: true; snapshots: BackupSnapshot[] } | { ok: false; error: string }

export type BackupsPageData =
  | { managed: true; status: BackupStatus; snapshots: SnapshotList | null; job: RestoreJob | null }
  | { managed: false; reason: string }

/** Overridable in tests (shared by the restore screen and the job endpoint below this page). */
export const _backupsDeps = {
  client: (): EeClient => new EeClient(),
  companyKey: (): Promise<BackupKeyMaterial> => companyBackupKey(),
  /** Loaded on use: the company profile store opens the database on import. */
  companyName: async (): Promise<string | null> =>
    (await import('$lib/server/overview/sources')).foundingCompanyName(),
  backupKeyFromCode: (code: string): Promise<string> => backupKeyFromRecoveryCode(code),
}

export async function _requireOwner(locals: App.Locals): Promise<string> {
  return requireOwner(locals)
}

async function requireOwner(locals: App.Locals): Promise<string> {
  const { user } = await requireCapability(locals, 'backups.manage', 'Only the owner can manage backups.')
  return `human:${user.id}`
}

export const load: PageServerLoad = async ({ locals }): Promise<{ backups: BackupsPageData }> => {
  await requireOwner(locals)
  try {
    const client = _backupsDeps.client()
    const status = await client.backups()
    const { job } = await client.restoreJob()
    let snapshots: SnapshotList | null = null
    if (status.configured) {
      try {
        snapshots = { ok: true, snapshots: (await client.backupSnapshots()).snapshots }
      } catch (err) {
        if (!(err instanceof SubstrateError)) throw err
        snapshots = { ok: false, error: err.message }
      }
    }
    return { backups: { managed: true, status, snapshots, job } }
  } catch (err) {
    if (err instanceof SubstrateUnavailableError) return { backups: { managed: false, reason: err.message } }
    throw err
  }
}

type TargetInput = Omit<BackupTarget, 'secretAccessKey'> & { secretAccessKey?: string }

function readTarget(form: FormData): TargetInput {
  const str = (k: string) => (form.get(k) ?? '').toString().trim()
  const secret = str('secretAccessKey')
  const addressing = str('addressing')
  if (addressing !== 'path' && addressing !== 'virtual') throw new FormError('Choose path-style or virtual-host addressing.')
  return {
    endpoint: str('endpoint'),
    region: str('region'),
    bucket: str('bucket'),
    prefix: str('prefix').replace(/^\/+|\/+$/g, ''),
    addressing,
    accessKeyId: str('accessKeyId'),
    ...(secret ? { secretAccessKey: secret } : {}),
  }
}

class FormError extends Error {}

function int(form: FormData, k: string, min: number, max: number, label: string): number {
  const n = Number((form.get(k) ?? '').toString())
  if (!Number.isInteger(n) || n < min || n > max) throw new FormError(`${label} must be a whole number from ${min} to ${max}.`)
  return n
}

async function act<T extends Record<string, unknown>>(action: string, run: () => Promise<T>) {
  try {
    return { action, ok: true as const, ...(await run()) }
  } catch (err) {
    if (err instanceof FormError) return fail(400, { action, error: err.message })
    if (err instanceof SubstrateUnavailableError) return fail(503, { action, error: err.message })
    if (err instanceof SubstrateError) return fail(err.status >= 500 ? 502 : err.status, { action, error: err.message })
    throw err
  }
}

export const actions: Actions = {
  test: async ({ locals, request }) => {
    await requireOwner(locals)
    const form = await request.formData()
    return act('test', async () => {
      const r = await _backupsDeps.client().testBackupTarget(readTarget(form))
      if (!r.ok) throw new FormError(`Connection failed: ${r.error}`)
      return {}
    })
  },
  save: async ({ locals, request }) => {
    const author = await requireOwner(locals)
    const form = await request.formData()
    return act('save', async () => {
      const target = readTarget(form)
      const schedule = { hour: int(form, 'hour', 0, 23, 'The hour') }
      const retentionDays = int(form, 'retentionDays', 1, 3650, 'Keep backups for')
      const client = _backupsDeps.client()
      const firstSetup = !(await client.backups()).configured
      // The backup key is derived from the company root key: one recovery code for everything.
      const key = await _backupsDeps.companyKey()
      await client.configureBackups({ target, schedule, retentionDays, backupKey: key.backupKey, author })
      // On first setup the owner confirms the company recovery code here (the same EE1-… code,
      // never a second one); it is in this one response only.
      return { recoveryCode: firstSetup ? key.recoveryCode : null }
    })
  },
  run: async ({ locals }) => {
    const author = await requireOwner(locals)
    return act('run', async () => {
      const { run } = await _backupsDeps.client().runBackup({ author })
      return { runId: run.id }
    })
  },
  /** Check one backup: ee downloads, decrypts and hashes all of it. Writes nothing. */
  check: async ({ locals, request }) => {
    const author = await requireOwner(locals)
    const form = await request.formData()
    return act('check', async () => {
      const snapshotId = (form.get('snapshotId') ?? '').toString()
      if (!BACKUP_SNAPSHOT_ID.test(snapshotId)) throw new FormError('Choose a backup to check.')
      const { job } = await _backupsDeps.client().checkBackup({ snapshotId, author })
      return { jobId: job.id, snapshotId }
    })
  },
}
