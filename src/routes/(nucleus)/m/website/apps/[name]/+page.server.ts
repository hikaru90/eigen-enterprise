import type { DeployProgress } from '../../../../../../../modules/website/apps/deploy-jobs'
import type { DeployStatus, ServiceView } from '../../../../../../../modules/website/apps/tools'
import type { Actions, PageServerLoad } from './$types'
import { error, fail, redirect } from '@sveltejs/kit'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { lastAttempt } from '$lib/server/website/deploy-runner'
import { logAppFailure, ownerRun, plainAppMessage } from '$lib/server/website/owner-run'

/**
 * /m/website/apps/[name]: one service — Deploy now (in the background, followed
 * through deploy-progress), the last attempt's log and "Ask AI", deploy history (ee's
 * journal), recent logs, domains, env variables (names only; values are
 * stored sealed by ee and never shown again).
 */

export type AppDetail = ServiceView & {
  env: string[]
  domains: string[]
  contractSource: 'repo' | 'form'
  contract: unknown
  history: Array<{ time: string; type: string; message: string }>
}

export const load: PageServerLoad = async (event) => {
  const user = await requireAdmin(event.locals.user)
  const name = event.params.name
  let app: AppDetail
  try {
    app = await ownerRun<AppDetail>(user, 'website.app_get', { name })
  } catch (err) {
    logAppFailure('website.app_get', err)
    error(404, plainAppMessage(err))
  }
  let logs: string[] = []
  let logsError: string | null = null
  try {
    logs = (await ownerRun<{ lines: string[] }>(user, 'website.app_logs', { name })).lines
  } catch (err) {
    logsError = plainAppMessage(err)
  }
  // The last attempt (stage, plain cause, log): a failure stays visible with "Ask AI" after a reload.
  let lastDeploy: DeployProgress | null = null
  try {
    lastDeploy = lastAttempt(
      name,
      await ownerRun<DeployStatus>(user, 'website.app_deploy_status', { name }),
    )
  } catch (err) {
    logAppFailure('website.app_deploy_status', err)
  }
  return { app, logs, logsError, lastDeploy }
}

const field = (f: FormData, name: string) => String(f.get(name) ?? '').trim()

export const actions: Actions = {
  env: async (event) => {
    const user = await requireAdmin(event.locals.user)
    const f = await event.request.formData()
    const key = field(f, 'key')
    try {
      const out = await ownerRun<{ applied: boolean }>(user, 'website.app_env_set', {
        name: event.params.name,
        key,
        value: String(f.get('value') ?? ''),
      })
      return {
        action: 'env' as const,
        ok: true,
        message: out.applied
          ? `Saved ${key}. The app restarted with it.`
          : `Saved ${key}, but the app didn't restart cleanly with it — see the deploy history.`,
      }
    } catch (err) {
      logAppFailure('website.app_env_set', err)
      return fail(400, { action: 'env' as const, error: plainAppMessage(err) })
    }
  },
  remove: async (event) => {
    const user = await requireAdmin(event.locals.user)
    try {
      await ownerRun(user, 'website.app_remove', { name: event.params.name })
    } catch (err) {
      logAppFailure('website.app_remove', err)
      return fail(400, { action: 'remove' as const, error: plainAppMessage(err) })
    }
    redirect(303, '/m/website/apps')
  },
}
