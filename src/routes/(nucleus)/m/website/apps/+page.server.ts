import type { ServiceView } from '../../../../../../modules/website/apps/tools'
import type { ConnectedRepoView } from '../../../../../../modules/website/github/connect-tools'
import type { Actions, PageServerLoad } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { requireAdmin } from '$lib/server/auth/require-admin'
import type { Catalog } from '$lib/server/ee/client'
import { settleBriefly, startOwnerDeploy } from '$lib/server/website/deploy-runner'
import { logAppFailure, ownerRun, plainAppMessage } from '$lib/server/website/owner-run'
import { contractFormSchema } from '../../../../../../modules/website/apps/contract'
import { appSlug } from '../../../../../../modules/website/apps/host'
import { formContract } from './form'

const SETTLE_MS = 1500

/**
 * /m/website/apps: services deployed from connected GitHub repos, and the
 * form to deploy a new one. The owner's click is their approval (ownerRun).
 */

export const load: PageServerLoad = async (event) => {
  const user = await requireAdmin(event.locals.user)
  const { repos } = await ownerRun<{ repos: ConnectedRepoView[] }>(
    user,
    'website.github_list_repos',
    {},
  )
  let services: ServiceView[] = []
  let catalog: Catalog | null = null
  let error: string | null = null
  try {
    const out = await ownerRun<{ services: ServiceView[]; catalog: Catalog }>(
      user,
      'website.app_list',
      {},
    )
    services = out.services
    catalog = out.catalog
  } catch (err) {
    logAppFailure('website.app_list', err)
    error = plainAppMessage(err)
  }
  return {
    services,
    catalog,
    error,
    repos: repos.map((r) => ({
      fullName: r.fullName,
      branch: r.branch,
      authKind: r.authKind,
      suggestedName: appSlug(r.fullName.split('/')[1] ?? r.fullName),
    })),
  }
}

const field = (f: FormData, name: string) => String(f.get(name) ?? '').trim()
const optional = (v: string) => (v === '' ? undefined : v)

export const actions: Actions = {
  deploy: async (event) => {
    const user = await requireAdmin(event.locals.user)
    const f = await event.request.formData()
    const [repo, branch] = field(f, 'source').split('#')
    const name = field(f, 'name')
    const contract = formContract(f)
    if (contract) {
      const checked = contractFormSchema.safeParse(contract)
      if (!checked.success) {
        return fail(400, {
          action: 'deploy' as const,
          name,
          error: checked.error.issues[0]?.message ?? 'Check the build form.',
        })
      }
    }
    const input = {
      name,
      repo,
      branch,
      kind: field(f, 'kind') === 'backend' ? 'backend' : 'web',
      ...(contract ? { contract } : {}),
      ...(optional(field(f, 'host')) ? { host: field(f, 'host') } : {}),
      ...(field(f, 'autoDeploy') === 'on' ? { autoDeploy: true } : {}),
    }
    // In the background: the page follows the job (stage + log) instead of one long request.
    const job = startOwnerDeploy(user, input)
    await settleBriefly(job, SETTLE_MS)
    if (job.state === 'failed') {
      // An instant refusal (form, repo, name) goes straight back to the form; the page
      // still follows the job, so a recorded attempt shows its log and "Ask AI".
      return fail(400, { action: 'deploy' as const, name, error: job.error ?? '', jobId: job.id })
    }
    if (job.state === 'done') redirect(303, `/m/website/apps/${name}`)
    return { action: 'deploy' as const, name, jobId: job.id }
  },
}
