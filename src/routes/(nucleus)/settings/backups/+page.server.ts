import type { Actions, PageServerLoad } from './$types'
import { fail } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { requireCapability } from '$lib/server/auth/require-capability'
import { errorReport } from '$lib/server/errors/report'
import type { ErrorReport } from '$lib/errors/agent-report'
import {
  backupKeyFromRecoveryCode,
  companyBackupKey,
  takePendingRecoveryCode,
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
export type SnapshotList = { ok: true; snapshots: BackupSnapshot[] } | ({ ok: false } & ErrorReport)

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
  /** The recovery code the owner never saw (the fleet created the root key); taking it marks it shown. */
  takePendingRecoveryCode: (): Promise<string | null> => takePendingRecoveryCode(),
  /**
   * A managed box (ee injected EE_FLEET_LOCAL_TOKEN): the hosting control plane keeps an
   * encrypted copy of the backup key (plan/phase-managed-box.md D7), so the page must say so.
   */
  hostingKeepsKey: (): boolean => Boolean(env.EE_FLEET_LOCAL_TOKEN),
}

export async function _requireOwner(locals: App.Locals): Promise<string> {
  return requireOwner(locals)
}

async function requireOwner(locals: App.Locals): Promise<string> {
  const { user } = await requireCapability(
    locals,
    'backups.manage',
    'Only the owner can manage backups.',
  )
  return `human:${user.id}`
}

export const load: PageServerLoad = async ({
  locals,
}): Promise<{
  backups: BackupsPageData
  pendingRecoveryCode?: string | null
  hostingKeepsKey: boolean
}> => {
  await requireOwner(locals)
  const backups = await loadBackups()
  // Shown once: a managed box got its backup key from os before the owner ever set backups up.
  return {
    backups,
    pendingRecoveryCode: backups.managed ? await _backupsDeps.takePendingRecoveryCode() : null,
    hostingKeepsKey: _backupsDeps.hostingKeepsKey(),
  }
}

async function loadBackups(): Promise<BackupsPageData> {
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
        snapshots = {
          ok: false,
          ...errorReport(err, {
            attempted:
              'Listing the backups in the bucket (Settings → Backups, ee GET /v1/backups/snapshots)',
            plain: () => err.message,
            nextSteps: [
              'ee could not list the backup bucket. Check the bucket settings and credentials on this page and `ee backup status` / the ee journal on the server.',
            ],
          }),
        }
      }
    }
    return { managed: true, status, snapshots, job }
  } catch (err) {
    if (err instanceof SubstrateUnavailableError) return { managed: false, reason: err.message }
    throw err
  }
}

type TargetInput = Omit<BackupTarget, 'secretAccessKey'> & { secretAccessKey?: string }

function readTarget(form: FormData): TargetInput {
  const str = (k: string) => (form.get(k) ?? '').toString().trim()
  const secret = str('secretAccessKey')
  const addressing = str('addressing')
  if (addressing !== 'path' && addressing !== 'virtual')
    throw new FormError('Choose path-style or virtual-host addressing.')
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
  if (!Number.isInteger(n) || n < min || n > max)
    throw new FormError(`${label} must be a whole number from ${min} to ${max}.`)
  return n
}

type BackupAction = 'test' | 'save' | 'run' | 'check'

const ATTEMPTED: Record<BackupAction, string> = {
  test: 'Testing the backup bucket connection (Settings → Backups, ee POST /v1/backups/test)',
  save: 'Saving the backup settings (Settings → Backups, ee configureBackups)',
  run: 'Starting a backup now (Settings → Backups, ee runBackup)',
  check: 'Checking one backup in the bucket (Settings → Backups, ee checkBackup)',
}

const STEPS = {
  form: 'The form was refused before ee was asked (readTarget / int in src/routes/(nucleus)/settings/backups/+page.server.ts); the sentence names the field.',
  unavailable:
    'ee is not reachable from the console (SubstrateUnavailableError). Check that ee runs on the server (`systemctl status ee`) and its journal.',
  substrate:
    'ee refused or failed (SubstrateError, `details.status` is its HTTP status). Read `ee backup status` and the ee journal on the server at the time above.',
}

/** The target fields for the agent half: never the secret. */
function targetInput(form: FormData) {
  const str = (k: string) => (form.get(k) ?? '').toString().trim()
  return {
    endpoint: str('endpoint'),
    region: str('region'),
    bucket: str('bucket'),
    prefix: str('prefix'),
    addressing: str('addressing'),
  }
}

async function act<T extends Record<string, unknown>>(
  action: BackupAction,
  run: () => Promise<T>,
  input?: unknown,
) {
  try {
    return { action, ok: true as const, ...(await run()) }
  } catch (err) {
    const report = (step: string) =>
      errorReport(err, {
        attempted: ATTEMPTED[action],
        ...(input !== undefined ? { input } : {}),
        plain: (e) => (e as Error).message,
        nextSteps: [step],
      })
    if (err instanceof FormError) return fail(400, { action, ...report(STEPS.form) })
    if (err instanceof SubstrateUnavailableError)
      return fail(503, { action, ...report(STEPS.unavailable) })
    if (err instanceof SubstrateError)
      return fail(err.status >= 500 ? 502 : err.status, { action, ...report(STEPS.substrate) })
    throw err
  }
}

export const actions: Actions = {
  test: async ({ locals, request }) => {
    await requireOwner(locals)
    const form = await request.formData()
    return act(
      'test',
      async () => {
        const r = await _backupsDeps.client().testBackupTarget(readTarget(form))
        if (!r.ok) throw new FormError(`Connection failed: ${r.error}`)
        return {}
      },
      targetInput(form),
    )
  },
  save: async ({ locals, request }) => {
    const author = await requireOwner(locals)
    const form = await request.formData()
    return act(
      'save',
      async () => {
        const target = readTarget(form)
        const schedule = { hour: int(form, 'hour', 0, 23, 'The hour') }
        const retentionDays = int(form, 'retentionDays', 1, 3650, 'Keep backups for')
        const client = _backupsDeps.client()
        const firstSetup = !(await client.backups()).configured
        // The backup key is derived from the company root key: one recovery code for everything.
        const key = await _backupsDeps.companyKey()
        await client.configureBackups({
          target,
          schedule,
          retentionDays,
          backupKey: key.backupKey,
          author,
        })
        // On first setup the owner confirms the company recovery code here (the same EE1-… code,
        // never a second one); it is in this one response only.
        return { recoveryCode: firstSetup ? key.recoveryCode : null }
      },
      { ...targetInput(form), hour: form.get('hour'), retentionDays: form.get('retentionDays') },
    )
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
    return act(
      'check',
      async () => {
        const snapshotId = (form.get('snapshotId') ?? '').toString()
        if (!BACKUP_SNAPSHOT_ID.test(snapshotId)) throw new FormError('Choose a backup to check.')
        const { job } = await _backupsDeps.client().checkBackup({ snapshotId, author })
        return { jobId: job.id, snapshotId }
      },
      { snapshotId: (form.get('snapshotId') ?? '').toString() },
    )
  },
}
