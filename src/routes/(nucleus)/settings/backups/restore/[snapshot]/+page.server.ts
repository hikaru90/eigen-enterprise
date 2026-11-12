import type { Actions, PageServerLoad } from './$types'
import { error, fail } from '@sveltejs/kit'
import {
  BACKUP_SNAPSHOT_ID,
  SubstrateError,
  SubstrateUnavailableError,
  type RestoreJob,
} from '$lib/server/ee/client'
import { CompanyKeyError } from '$lib/server/gitstore/keys'
import { _backupsDeps, _requireOwner } from '../../+page.server'

/**
 * Settings → Backups → Restore (owner only, D11): replace this whole server
 * with one backup. ee does it, like `ee restore` on the CLI: it downloads and
 * checks every file first (nothing is touched if anything fails), then stops
 * the company, puts back the database, Drive, the agent's memory and its own
 * settings, and starts everything again. The owner confirms by typing the
 * company name and gives the company recovery code, as the CLI asks for it;
 * the code only becomes the backup key here, is handed to ee and is never
 * stored, logged or sent back.
 */

export type RestorePageData =
  | {
      managed: true
      configured: boolean
      snapshotId: string
      takenAt: string
      companyName: string | null
      job: RestoreJob | null
    }
  | { managed: false; reason: string }

/** 20261103T031700Z → 2026-11-03T03:17:00.000Z */
function takenAt(id: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(id)!
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`).toISOString()
}

function snapshotParam(raw: string): string {
  if (!BACKUP_SNAPSHOT_ID.test(raw)) error(404, 'There is no such backup.')
  return raw
}

export const load: PageServerLoad = async ({ locals, params }): Promise<{ restore: RestorePageData }> => {
  await _requireOwner(locals)
  const snapshotId = snapshotParam(params.snapshot)
  try {
    const client = _backupsDeps.client()
    const status = await client.backups()
    const { job } = await client.restoreJob()
    return {
      restore: {
        managed: true,
        configured: status.configured,
        snapshotId,
        takenAt: takenAt(snapshotId),
        companyName: await _backupsDeps.companyName(),
        job,
      },
    }
  } catch (err) {
    if (err instanceof SubstrateUnavailableError) return { restore: { managed: false, reason: err.message } }
    throw err
  }
}

export const actions: Actions = {
  restore: async ({ locals, params, request }) => {
    const author = await _requireOwner(locals)
    const snapshotId = snapshotParam(params.snapshot)
    const form = await request.formData()
    const confirmName = (form.get('confirmName') ?? '').toString().trim()
    const code = (form.get('recoveryCode') ?? '').toString().trim()
    const companyName = (await _backupsDeps.companyName())?.trim() ?? null
    if (!companyName) {
      return fail(409, { action: 'restore', error: 'This company has no name yet. Name it in Settings → Company first — restoring asks you to type it.' })
    }
    if (confirmName !== companyName) {
      return fail(400, { action: 'restore', error: `Type the company name exactly as shown (${companyName}) to confirm.` })
    }
    if (!code) return fail(400, { action: 'restore', error: 'Enter the company recovery code (EE1-…).' })
    let backupKey: string
    try {
      backupKey = await _backupsDeps.backupKeyFromCode(code)
    } catch (err) {
      if (err instanceof CompanyKeyError) return fail(400, { action: 'restore', error: `That recovery code is not right: ${err.message}.` })
      throw err
    }
    try {
      const { job } = await _backupsDeps.client().restoreBackup({ snapshotId, backupKey, author })
      return { action: 'restore', ok: true as const, job }
    } catch (err) {
      if (err instanceof SubstrateUnavailableError) return fail(503, { action: 'restore', error: err.message })
      if (err instanceof SubstrateError) return fail(err.status >= 500 ? 502 : err.status, { action: 'restore', error: err.message })
      throw err
    }
  },
}
