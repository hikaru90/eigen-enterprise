import type { Actions, PageServerLoad } from './$types'
import { error, fail } from '@sveltejs/kit'
import {
  BACKUP_SNAPSHOT_ID,
  SubstrateError,
  SubstrateUnavailableError,
  type RestoreJob,
} from '$lib/server/ee/client'
import { CompanyKeyError } from '$lib/server/gitstore/keys'
import { errorReport, refusalReport } from '$lib/server/errors/report'
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

export const load: PageServerLoad = async ({
  locals,
  params,
}): Promise<{ restore: RestorePageData }> => {
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
    if (err instanceof SubstrateUnavailableError)
      return { restore: { managed: false, reason: err.message } }
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
    // The agent half never carries the recovery code or the backup key: only which backup.
    const attempted = `Restoring the backup ${snapshotId} (Settings → Backups → Restore)`
    const input = { snapshotId }
    const refuse = (status: number, sentence: string, step: string) =>
      fail(status, {
        action: 'restore',
        ...refusalReport(sentence, { attempted, input, nextSteps: [step] }),
      })
    const FORM_STEP =
      'The restore form was refused before ee was asked (src/routes/(nucleus)/settings/backups/restore/[snapshot]/+page.server.ts); nothing was touched. The sentence says what the person has to fix.'
    if (!companyName) {
      return refuse(
        409,
        'This company has no name yet. Name it in Settings → Company first — restoring asks you to type it.',
        FORM_STEP,
      )
    }
    if (confirmName !== companyName) {
      return refuse(
        400,
        `Type the company name exactly as shown (${companyName}) to confirm.`,
        FORM_STEP,
      )
    }
    if (!code) return refuse(400, 'Enter the company recovery code (EE1-…).', FORM_STEP)
    let backupKey: string
    try {
      backupKey = await _backupsDeps.backupKeyFromCode(code)
    } catch (err) {
      if (err instanceof CompanyKeyError) {
        const refused = refuse(
          400,
          `That recovery code is not right: ${err.message}.`,
          'backupKeyFromRecoveryCode refused the code (CompanyKeyError). Only the owner holds the code; an agent never asks for it or types it.',
        )
        refused.data.agent.code = 'CompanyKeyError'
        return refused
      }
      throw err
    }
    try {
      const { job } = await _backupsDeps.client().restoreBackup({ snapshotId, backupKey, author })
      return { action: 'restore', ok: true as const, job }
    } catch (err) {
      const report = (step: string) =>
        errorReport(err, {
          attempted,
          input,
          plain: (e) => (e as Error).message,
          nextSteps: [step],
        })
      if (err instanceof SubstrateUnavailableError) {
        return fail(503, {
          action: 'restore',
          ...report(
            'ee is not reachable from the console. Check `systemctl status ee` and its journal on the server.',
          ),
        })
      }
      if (err instanceof SubstrateError) {
        return fail(err.status >= 500 ? 502 : err.status, {
          action: 'restore',
          ...report(
            'ee refused or failed the restore (SubstrateError, `details.status` is its HTTP status). Read the ee journal on the server at the time above; nothing is touched unless every file checked out.',
          ),
        })
      }
      throw err
    }
  },
}
