import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { requireAdmin } from '$lib/server/auth/require-admin'
import type { AppContract } from '$lib/server/ee/client'
import { refusalReport } from '$lib/server/errors/report'
import { startOwnerDeploy } from '$lib/server/website/deploy-runner'
import { appErrorReport, logAppFailure, ownerRun } from '$lib/server/website/owner-run'
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
      return json(
        refusalReport('Those build changes are not valid.', {
          attempted: `Redeploying ${name} with the AI's build changes`,
          input: { changes: body.changes },
          cause: changes.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          nextSteps: [
            'The suggested changes failed contractChangesSchema (modules/website/apps/diagnose.ts): the diagnosis produced, or the page sent, a field the schema refuses.',
          ],
        }),
        { status: 400 },
      )
    try {
      const app = await ownerRun<{ contractSource: 'repo' | 'form'; contract: AppContract | null }>(
        user,
        'website.app_get',
        { name },
      )
      if (app.contractSource === 'repo' || !app.contract) {
        return json(
          refusalReport(
            "This app builds from the repo's own ee.json, so the change has to be made there.",
            {
              attempted: `Redeploying ${name} with the AI's build changes`,
              tool: 'website.app_get',
              input: { name },
              nextSteps: [
                `The app's build contract comes from ee.json in its repository: make the change there and push, then redeploy.`,
              ],
            },
          ),
          { status: 409 },
        )
      }
      input = { name, contract: { ...formFromContract(app.contract), ...changes.data } }
    } catch (err) {
      logAppFailure('website.app_get', err)
      return json(
        appErrorReport(err, {
          attempted: `Reading ${name} before redeploying it`,
          tool: 'website.app_get',
          input: { name },
        }),
        { status: 400 },
      )
    }
  }
  const job = startOwnerDeploy(user, input)
  return json({ jobId: job.id })
}
