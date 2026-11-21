import { randomUUID } from 'node:crypto'
import type { AgentReport, ErrorReport } from '$lib/errors/agent-report'
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
  /** The agent half of the failure (ErrorReport.agent). */
  agent: AgentReport | null
  done: Promise<void>
}

export class DeployJobs {
  private jobs = new Map<string, DeployJob>()

  constructor(private readonly now: () => Date = () => new Date()) {}

  start(
    name: string,
    run: () => Promise<unknown>,
    report: (err: unknown) => ErrorReport,
  ): DeployJob {
    const running = [...this.jobs.values()].find((j) => j.name === name && j.state === 'running')
    if (running) return running
    const job: DeployJob = {
      id: randomUUID(),
      name,
      startedAt: this.now(),
      state: 'running',
      error: null,
      agent: null,
      done: Promise.resolve(),
    }
    job.done = run().then(
      () => {
        job.state = 'done'
      },
      (err: unknown) => {
        job.state = 'failed'
        const r = report(err)
        job.error = r.error
        job.agent = r.agent
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
  /** The agent half of the failure (ErrorReport.agent). */
  agent: AgentReport | null
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

/** The agent half of a deploy ee recorded as failed: where it stopped and how to read why. */
export function deployFailureAgent(name: string, d: EeDeploy): AgentReport {
  const input = { name }
  return {
    attempted: `Deploying the app ${name}`,
    tool: 'website.app_deploy',
    input,
    code: `deploy_failed_while_${failedStageOf(d)}`,
    details: { deployId: d.id, stages: d.stages },
    ...(d.error ? { cause: d.error } : {}),
    nextSteps: [
      `Read the deploy log: \`ee tool run website.app_deploy_status --input '${JSON.stringify(input)}'\` (and \`website.app_logs\` for the running app).`,
      `Ask for a diagnosis: \`ee tool run website.app_diagnose --input '${JSON.stringify({ name, deployId: d.id })}'\`.`,
      "Fix the cause in the app's repository (build, start command, health check) or its build form, then deploy again.",
    ],
  }
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
      agent: null,
    }
  }
  if (job.state === 'done') {
    return { ...base, state: 'live', stage: 'live', failedStage: null, error: null, agent: null }
  }
  return {
    ...base,
    state: 'failed',
    stage: 'failed',
    failedStage: mine ? failedStageOf(mine) : 'fetching',
    error: job.error,
    agent: job.agent ?? (mine ? deployFailureAgent(job.name, mine) : null),
  }
}
