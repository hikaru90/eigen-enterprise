import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { jobProgress } from '$lib/server/website/deploy-runner'
import { logAppFailure, plainAppMessage } from '$lib/server/website/owner-run'
import { deployJobs } from '../../../../../../../../modules/website/apps/deploy-jobs'

/** GET ?job=<id>: where a background deploy is (stage, log, plain cause). The page polls this. */
export const GET: RequestHandler = async (event) => {
  const user = await requireAdmin(event.locals.user)
  const job = deployJobs.get(event.url.searchParams.get('job') ?? '')
  if (!job || job.name !== event.params.name) {
    return json(
      {
        error:
          'This deploy is not running on this server any more. Reload the page to see the last result.',
      },
      { status: 404 },
    )
  }
  try {
    return json(await jobProgress(user, job))
  } catch (err) {
    logAppFailure('website.app_deploy_status', err)
    return json({ error: plainAppMessage(err) }, { status: 502 })
  }
}
