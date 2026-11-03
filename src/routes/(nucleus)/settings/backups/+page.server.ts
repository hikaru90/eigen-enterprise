import type { Actions, PageServerLoad } from './$types'
import { error, fail, redirect } from '@sveltejs/kit'
import { getUserRole } from '$lib/server/auth/user-role'
import {
  EeClient,
  SubstrateError,
  SubstrateUnavailableError,
  type BackupStatus,
  type BackupTarget,
} from '$lib/server/ee/client'

/**
 * Settings → Backups (plan/phase-backups.md K2): the owner sets up the bucket,
 * keeps the recovery code, chooses schedule + retention, runs a backup now
 * and sees the last runs. Owner only — it is a server change (D11) and the
 * recovery code unlocks every backup. The person clicking is the decision, so
 * this page calls ee directly; the agent only has the read-only status tool.
 */

export type BackupsPageData =
  | { managed: true; status: BackupStatus }
  | { managed: false; reason: string }

/** Overridable in tests. */
export const _backupsDeps = { client: (): EeClient => new EeClient() }

async function requireOwner(locals: App.Locals): Promise<string> {
  const user = locals.user
  if (!user) throw redirect(302, '/login')
  if ((await getUserRole(user.id)) !== 'owner') error(403, 'Only the owner can manage backups.')
  return `human:${user.id}`
}

export const load: PageServerLoad = async ({ locals }): Promise<{ backups: BackupsPageData }> => {
  await requireOwner(locals)
  try {
    return { backups: { managed: true, status: await _backupsDeps.client().backups() } }
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
      const r = await _backupsDeps.client().configureBackups({
        target: readTarget(form),
        schedule: { hour: int(form, 'hour', 0, 23, 'The hour') },
        retentionDays: int(form, 'retentionDays', 1, 3650, 'Keep backups for'),
        author,
      })
      // The recovery code exists in this one response only; ee never returns it again.
      return { recoveryCode: r.recoveryCode }
    })
  },
  run: async ({ locals }) => {
    const author = await requireOwner(locals)
    return act('run', async () => {
      const { run } = await _backupsDeps.client().runBackup({ author })
      return { runId: run.id }
    })
  },
}
