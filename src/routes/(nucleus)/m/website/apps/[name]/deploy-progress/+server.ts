import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { refusalReport } from '$lib/server/errors/report'
import { jobProgress } from '$lib/server/website/deploy-runner'
import { appErrorReport, logAppFailure } from '$lib/server/website/owner-run'
import { deployJobs } from '../../../../../../../../modules/website/apps/deploy-jobs'

/** GET ?job=<id>: where a background deploy is (stage, log, plain cause). The page polls this. */
export const GET: RequestHandler = async (event) => {
  const user = await requireAdmin(event.locals.user)
  const job = deployJobs.get(event.url.searchParams.get('job') ?? '')
  if (!job || job.name !== event.params.name) {
    return json(
      refusalReport(
        'This deploy is not running on this server any more. Reload the page to see the last result.',
        {
          attempted: `Following the deploy of ${event.params.name}`,
          cause: `No deploy job ${event.url.searchParams.get('job') ?? '(none)'} for ${event.params.name} in this process.`,
          nextSteps: [
            'Deploy jobs live in process memory (modules/website/apps/deploy-jobs.ts): a restart or the other blue/green unit loses them. Read the last attempt with `ee tool run website.app_deploy_status`.',
          ],
        },
      ),
      { status: 404 },
    )
  }
  try {
    return json(await jobProgress(user, job))
  } catch (err) {
    logAppFailure('website.app_deploy_status', err)
    return json(
      appErrorReport(err, {
        attempted: `Following the deploy of ${job.name}`,
        tool: 'website.app_deploy_status',
        input: { name: job.name, after: job.startedAt.toISOString() },
      }),
      { status: 502 },
    )
  }
}
