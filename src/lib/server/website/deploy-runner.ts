import type { DeployStatus } from '../../../../modules/website/apps/tools'
import {
  deployJobs,
  deployProgress,
  failedStageOf,
  failureSentence,
  type DeployJob,
  type DeployProgress,
} from '../../../../modules/website/apps/deploy-jobs'
import { logAppFailure, ownerRun, plainAppMessage } from './owner-run'

/**
 * The owner's Deploy click runs `website.app_deploy` in the background (it can
 * take minutes: build + health gate); the page follows it by polling
 * progress. The click still counts as the owner's approval (ownerRun).
 */
export function startOwnerDeploy(
  user: { id: string },
  input: { name: string } & Record<string, unknown>,
): DeployJob {
  return deployJobs.start(
    input.name,
    () => ownerRun(user, 'website.app_deploy', input),
    (err) => {
      logAppFailure('website.app_deploy', err)
      return plainAppMessage(err)
    },
  )
}

/** Wait briefly so an instant answer (a plain validation error) can go straight back to the form. */
export async function settleBriefly(job: DeployJob, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([job.done, new Promise<void>((r) => (timer = setTimeout(r, ms)))])
  clearTimeout(timer)
}

export async function jobProgress(user: { id: string }, job: DeployJob): Promise<DeployProgress> {
  const status = await ownerRun<DeployStatus>(user, 'website.app_deploy_status', {
    name: job.name,
    after: job.startedAt.toISOString(),
  })
  return deployProgress(job, status.deploy, status.lines)
}

/** The last attempt ee recorded, shaped like progress (the detail page shows it on load). */
export function lastAttempt(name: string, status: DeployStatus): DeployProgress | null {
  const d = status.deploy
  if (!d) return null
  return {
    jobId: '',
    name,
    state: d.status,
    stage: d.stage,
    stages: d.stages,
    failedStage: d.status === 'failed' ? failedStageOf(d) : null,
    error: d.status === 'failed' ? failureSentence(name, d) : null,
    deployId: d.id,
    lines: status.lines,
  }
}
