import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { requireAdmin } from '$lib/server/auth/require-admin'
import type { AppContract } from '$lib/server/ee/client'
import { startOwnerDeploy } from '$lib/server/website/deploy-runner'
import { logAppFailure, ownerRun, plainAppMessage } from '$lib/server/website/owner-run'
import { formFromContract } from '../../../../../../../../modules/website/apps/contract'
import { contractChangesSchema } from '../../../../../../../../modules/website/apps/diagnose'

/**
 * POST: redeploy this app in the background → { jobId }. With `changes`
 * (the AI's suggested contract changes, accepted by the owner's click), they
 * are applied onto the stored build contract first.
 */
export const POST: RequestHandler = async (event) => {
  const user = await requireAdmin(event.locals.user)
  const name = event.params.name
  const body = (await event.request.json().catch(() => ({}))) as { changes?: unknown }
  let input: { name: string; contract?: ReturnType<typeof formFromContract> } = { name }
  if (body.changes !== undefined) {
    const changes = contractChangesSchema.safeParse(body.changes)
    if (!changes.success)
      return json({ error: 'Those build changes are not valid.' }, { status: 400 })
    try {
      const app = await ownerRun<{ contractSource: 'repo' | 'form'; contract: AppContract | null }>(
        user,
        'website.app_get',
        { name },
      )
      if (app.contractSource === 'repo' || !app.contract) {
        return json(
          {
            error:
              "This app builds from the repo's own ee.json, so the change has to be made there.",
          },
          { status: 409 },
        )
      }
      input = { name, contract: { ...formFromContract(app.contract), ...changes.data } }
    } catch (err) {
      logAppFailure('website.app_get', err)
      return json({ error: plainAppMessage(err) }, { status: 400 })
    }
  }
  const job = startOwnerDeploy(user, input)
  return json({ jobId: job.id })
}
