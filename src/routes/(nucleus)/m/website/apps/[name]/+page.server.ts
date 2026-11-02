import type { DeployProgress } from '../../../../../../../modules/website/apps/deploy-jobs'
import type { DeployStatus, ServiceView } from '../../../../../../../modules/website/apps/tools'
import type { Actions, PageServerLoad } from './$types'
import { error, fail, redirect } from '@sveltejs/kit'
import { requireAdmin } from '$lib/server/auth/require-admin'
import type { EeStatus } from '$lib/server/ee/client'
import { lastAttempt, startOwnerDeploy } from '$lib/server/website/deploy-runner'
import { logAppFailure, ownerRun, plainAppMessage } from '$lib/server/website/owner-run'
import {
  contractFormSchema,
  type AppContract,
  type Catalog,
} from '../../../../../../../modules/website/apps/contract'
import { contractFields, formContract } from '../form'

/**
 * /m/website/apps/[name]: one app — Redeploy (in the background, followed
 * through deploy-progress; it replays the saved build settings), its domains
 * (add/change/remove per app, D-W2), build settings, env variables (names
 * only; values stored sealed by ee), secrets (write-only via
 * substrate.secret_set), deploy history, recent logs.
 */

export type AppDetail = ServiceView & {
  env: string[]
  domains: string[]
  contractSource: 'repo' | 'form'
  contract: AppContract | null
  catalog: Catalog
  /** "Allow this app to send email": a mail-only key sealed into the app as EE_API_KEY. */
  mail: { enabled: boolean }
  history: Array<{ time: string; type: string; message: string }>
}

/** substrate.status: the server state, or the explicit "not managed by ee". */
type SubstrateView = ({ managed: true } & EeStatus) | { managed: false; reason: string }

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
  // Secret names for this workload (declared + set), from the substrate read —
  // values are write-only and never come back.
  const substrate = await ownerRun<SubstrateView>(user, 'substrate.status', {})
  const workload = substrate.managed ? substrate.workloads.find((w) => w.name === name) : undefined
  const secretNames = workload
    ? [...new Set([...workload.declaredSecrets, ...workload.secrets])].sort()
    : []
  return {
    app,
    logs,
    logsError,
    lastDeploy,
    nodeVersions: app.catalog.runtimes.node,
    contractFields: contractFields(app.contract),
    secretNames,
    managed: substrate.managed,
    // The how-to the app's coding agent reads; pinned from the app repo's AGENTS.md.
    howtoUrl: `${event.url.origin}/docs/send-mail.md`,
  }
}

const field = (f: FormData, name: string) => String(f.get(name) ?? '').trim()

export const actions: Actions = {
  deploy: async (event) => {
    const user = await requireAdmin(event.locals.user)
    // The build form, when the owner opened it to edit the contract for this redeploy.
    const contract = formContract(await event.request.formData())
    if (contract) {
      const checked = contractFormSchema.safeParse(contract)
      if (!checked.success) {
        return fail(400, {
          action: 'deploy' as const,
          error: checked.error.issues[0]?.message ?? 'Check the build form.',
        })
      }
    }
    // In the background: the page follows the job (stage + live log) from the submit handler.
    const job = startOwnerDeploy(user, {
      name: event.params.name,
      ...(contract ? { contract } : {}),
    })
    return { action: 'deploy' as const, jobId: job.id, name: event.params.name }
  },
  domainSet: async (event) => {
    const user = await requireAdmin(event.locals.user)
    const f = await event.request.formData()
    const host = field(f, 'host')
    const replace = field(f, 'replace')
    try {
      const out = await ownerRun<{ host: string; domains: string[] }>(
        user,
        'website.app_domain_set',
        {
          name: event.params.name,
          host,
          ...(replace ? { replace } : {}),
        },
      )
      return {
        action: 'domainSet' as const,
        ok: true,
        message: replace
          ? `This app now runs at ${out.host}.`
          : `${out.host} now points at this app.`,
      }
    } catch (err) {
      logAppFailure('website.app_domain_set', err)
      return fail(400, { action: 'domainSet' as const, error: plainAppMessage(err) })
    }
  },
  domainRemove: async (event) => {
    const user = await requireAdmin(event.locals.user)
    const host = field(await event.request.formData(), 'host')
    try {
      await ownerRun<{ host: string; domains: string[] }>(user, 'website.app_domain_remove', {
        name: event.params.name,
        host,
      })
      return {
        action: 'domainRemove' as const,
        ok: true,
        message: `${host} no longer serves this app.`,
      }
    } catch (err) {
      logAppFailure('website.app_domain_remove', err)
      return fail(400, { action: 'domainRemove' as const, error: plainAppMessage(err) })
    }
  },
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
  secretSet: async (event) => {
    const user = await requireAdmin(event.locals.user)
    const f = await event.request.formData()
    const name = field(f, 'name')
    try {
      await ownerRun(user, 'substrate.secret_set', {
        workload: event.params.name,
        name,
        value: String(f.get('value') ?? ''),
      })
      return {
        action: 'secretSet' as const,
        ok: true,
        message: `Saved ${name} as a secret. The app gets it sealed; the value is never shown again.`,
      }
    } catch (err) {
      logAppFailure('substrate.secret_set', err)
      return fail(400, { action: 'secretSet' as const, error: plainAppMessage(err) })
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
    redirect(303, '/m/website')
  },
  mailEnable: async (event) => {
    const user = await requireAdmin(event.locals.user)
    try {
      const out = await ownerRun<{ applied: boolean }>(user, 'website.app_mail_enable', {
        name: event.params.name,
      })
      return {
        action: 'mailEnable' as const,
        ok: true,
        message: out.applied
          ? 'Email is on. The app is being rebuilt with its key; that takes a few minutes. Hand the how-to below to whoever builds the app.'
          : "Email is on, but the app didn't rebuild cleanly with its key — see the deploy history.",
      }
    } catch (err) {
      logAppFailure('website.app_mail_enable', err)
      return fail(400, { action: 'mailEnable' as const, error: plainAppMessage(err) })
    }
  },
  mailDisable: async (event) => {
    const user = await requireAdmin(event.locals.user)
    try {
      await ownerRun(user, 'website.app_mail_disable', { name: event.params.name })
      return {
        action: 'mailDisable' as const,
        ok: true,
        message: "Email is off. The app's key is revoked; its next send is refused.",
      }
    } catch (err) {
      logAppFailure('website.app_mail_disable', err)
      return fail(400, { action: 'mailDisable' as const, error: plainAppMessage(err) })
    }
  },
}
