import type { Actions, PageServerLoad } from './$types'
import { fail } from '@sveltejs/kit'
import { requireCapability } from '$lib/server/auth/require-capability'
import { errorReport, refusalReport } from '$lib/server/errors/report'
import type { ErrorReport } from '$lib/errors/agent-report'
import {
  EeClient,
  SubstrateError,
  SubstrateUnavailableError,
  type LatestRelease,
  type UpgradeInfo,
} from '$lib/server/ee/client'

/**
 * Settings → Updates (owner and admins): which eigenEnterprise this server
 * runs, whether a newer signed release exists (with its notes), and the
 * button that updates it. ee does the update, like `ee upgrade` on the CLI
 * (ee/src/upgrade-job.ts): it checks the release's signature, takes a safety
 * copy, runs the installer and deploys the new app health-gated, in a process
 * that outlives this app restarting — the page reconnects and shows the end.
 * The person clicking is the decision (like Settings → Backups), so this
 * page calls ee directly; the agent has no verb to update the server.
 * A managed box is updated by its hosting provider: the page only shows it.
 */

export type LatestCheck = { ok: true; release: LatestRelease } | ({ ok: false } & ErrorReport)

export type UpdatesPageData =
  ({ onBox: true; latest: LatestCheck | null } & UpgradeInfo) | { onBox: false; reason: string }

/** Overridable in tests (shared by the job endpoint below this page). */
export const _updatesDeps = {
  client: (): EeClient => new EeClient(),
}

export async function _requireUpdater(locals: App.Locals): Promise<string> {
  const { user } = await requireCapability(
    locals,
    'updates.manage',
    'Only the owner or an admin can update eigenEnterprise.',
  )
  return `human:${user.id}`
}

export const load: PageServerLoad = async ({ locals }): Promise<{ updates: UpdatesPageData }> => {
  await _requireUpdater(locals)
  const client = _updatesDeps.client()
  let info: UpgradeInfo
  try {
    info = await client.upgrade()
  } catch (err) {
    if (err instanceof SubstrateUnavailableError)
      return { updates: { onBox: false, reason: err.message } }
    throw err
  }
  // Nothing to look up while an update runs, or on a box its hosting provider updates.
  if (info.managed || info.job?.status === 'running')
    return { updates: { onBox: true, ...info, latest: null } }
  let latest: LatestCheck
  try {
    latest = { ok: true, release: (await client.latestRelease()).latest }
  } catch (err) {
    if (err instanceof SubstrateError || err instanceof SubstrateUnavailableError) {
      latest = {
        ok: false,
        ...errorReport(err, {
          attempted:
            'Checking for a newer eigenEnterprise release (Settings → Updates, ee latestRelease)',
          plain: (e) => (e as Error).message,
          nextSteps: [
            'ee could not look up the newest signed release. Run `ee upgrade --check` on the server and read the ee journal.',
          ],
        }),
      }
    } else throw err
  }
  return { updates: { onBox: true, ...info, latest } }
}

export const actions: Actions = {
  update: async ({ locals, request }) => {
    const author = await _requireUpdater(locals)
    const release = ((await request.formData()).get('release') ?? '').toString().trim()
    const attempted = `Updating eigenEnterprise to ${release || 'a release'} (Settings → Updates, ee startUpgrade)`
    if (!release) {
      return fail(400, {
        action: 'update',
        ...refusalReport('Check for updates again: no release was chosen.', {
          attempted,
          nextSteps: [
            'The update form sent no release: reload Settings → Updates so it offers the newest release again.',
          ],
        }),
      })
    }
    try {
      const { job } = await _updatesDeps.client().startUpgrade({ release, author })
      return { action: 'update', ok: true as const, job }
    } catch (err) {
      const report = (step: string) =>
        errorReport(err, {
          attempted,
          input: { release },
          plain: (e) => (e as Error).message,
          nextSteps: [step],
        })
      if (err instanceof SubstrateUnavailableError) {
        return fail(503, {
          action: 'update',
          ...report(
            'ee is not reachable from the console. Check `systemctl status ee` and its journal on the server.',
          ),
        })
      }
      if (err instanceof SubstrateError) {
        return fail(err.status >= 500 ? 502 : err.status, {
          action: 'update',
          ...report(
            'ee refused or failed to start the update (SubstrateError, `details.status` is its HTTP status). Read the ee journal on the server; `ee upgrade` on the CLI does the same steps.',
          ),
        })
      }
      throw err
    }
  },
}
