import { randomUUID } from 'node:crypto'
import type { EeDeploy, EeDeployStage } from '$lib/server/ee/client'

/**
 * A deploy started from a page runs in the background, server-side: the click
 * returns at once with a job id, and the page polls progress (ee's deploy
 * record + log) until the job ends. One running job per app; a second click
 * while it runs joins the same job.
 */

export type DeployJob = {
  id: string
  name: string
  startedAt: Date
  state: 'running' | 'done' | 'failed'
  /** The plain sentence the deploy ended with on failure. */
  error: string | null
  done: Promise<void>
}

export class DeployJobs {
  private jobs = new Map<string, DeployJob>()

  constructor(private readonly now: () => Date = () => new Date()) {}

  start(name: string, run: () => Promise<unknown>, plain: (err: unknown) => string): DeployJob {
    const running = [...this.jobs.values()].find((j) => j.name === name && j.state === 'running')
    if (running) return running
    const job: DeployJob = {
      id: randomUUID(),
      name,
      startedAt: this.now(),
      state: 'running',
      error: null,
      done: Promise.resolve(),
    }
    job.done = run().then(
      () => {
        job.state = 'done'
      },
      (err: unknown) => {
        job.state = 'failed'
        job.error = plain(err)
      },
    )
    this.jobs.set(job.id, job)
    // Bounded: only the most recent jobs are kept.
    if (this.jobs.size > 50) {
      const oldest = [...this.jobs.values()].find((j) => j.state !== 'running')
      if (oldest) this.jobs.delete(oldest.id)
    }
    return job
  }

  get(id: string): DeployJob | null {
    return this.jobs.get(id) ?? null
  }
}

/** Process-wide: the page that starts a deploy and the route that reports it share it. */
export const deployJobs = new DeployJobs()

export type DeployProgress = {
  jobId: string
  name: string
  state: 'running' | 'live' | 'failed'
  stage: EeDeployStage
  stages: Array<{ stage: EeDeployStage; at: string }>
  /** The stage that failed, when it failed. */
  failedStage: EeDeployStage | null
  /** The plain one-line cause (ee's when it recorded one). */
  error: string | null
  deployId: string | null
  lines: string[]
}

export const STAGE_WORDS: Record<EeDeployStage, string> = {
  fetching: 'fetching the code',
  building: 'building',
  starting: 'starting',
  health: 'waiting for its health check',
  live: 'going live',
  failed: 'deploying',
}

export const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`)

/** "<app> failed while <stage>: <ee's plain cause>." */
export function failureSentence(name: string, d: EeDeploy): string {
  return `${name} failed while ${STAGE_WORDS[failedStageOf(d)]}: ${sentence(d.error ?? 'no cause was recorded')}`
}

/** The stage before `failed` (ee records the path it took). */
export function failedStageOf(d: EeDeploy): EeDeployStage {
  const before = d.stages.filter((s) => s.stage !== 'failed').at(-1)
  return before?.stage ?? 'fetching'
}

/** Combine the OS job (fetching happens before ee records anything) with ee's attempt record. */
export function deployProgress(
  job: DeployJob,
  deploy: EeDeploy | null,
  lines: string[],
): DeployProgress {
  const mine =
    deploy && Date.parse(deploy.startedAt) >= job.startedAt.getTime() - 1000 ? deploy : null
  const base = {
    jobId: job.id,
    name: job.name,
    deployId: mine?.id ?? null,
    lines: mine ? lines : [],
    stages: mine?.stages ?? [{ stage: 'fetching' as const, at: job.startedAt.toISOString() }],
  }
  if (job.state === 'running') {
    return {
      ...base,
      state: 'running',
      stage: mine?.stage ?? 'fetching',
      failedStage: null,
      error: null,
    }
  }
  if (job.state === 'done') {
    return { ...base, state: 'live', stage: 'live', failedStage: null, error: null }
  }
  return {
    ...base,
    state: 'failed',
    stage: 'failed',
    failedStage: mine ? failedStageOf(mine) : 'fetching',
    error: job.error,
  }
}
