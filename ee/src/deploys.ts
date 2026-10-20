import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Journal } from './journal.ts'
import { PATHS } from './paths.ts'
import type { SecretMap } from './secrets.ts'
import type { System } from './system.ts'

/**
 * One deploy attempt of one workload: where it is (stages with timestamps),
 * how it ended, and a bounded, secret-redacted log of what the build and the
 * candidate unit printed. The OS polls this to show progress and, on failure,
 * hands it to the agent harness (code ↔ harness ↔ user: never a dead end).
 */

export const DEPLOY_STAGES = ['fetching', 'building', 'starting', 'health', 'live', 'failed'] as const
export type DeployStage = (typeof DEPLOY_STAGES)[number]

export const deployRecordSchema = z.object({
  id: z.string(),
  workload: z.string(),
  release: z.string().nullable(),
  status: z.enum(['running', 'live', 'failed']),
  stage: z.enum(DEPLOY_STAGES),
  stages: z.array(z.object({ stage: z.enum(DEPLOY_STAGES), at: z.string() })),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  /** The plain one-line cause ee recorded (no stack, no log). */
  error: z.string().nullable(),
})
export type DeployRecord = z.infer<typeof deployRecordSchema>

/** Lines kept per deploy log. */
export const LOG_LINES = 400
/** Deploy records kept per workload in the journal. */
const KEEP_PER_WORKLOAD = 20
export const DEPLOY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const deployLogPath = (id: string) => `${PATHS.root}/deploys/${id}.log`

/** Logs of deploys still running live in memory, so a poll sees them before they are flushed. */
const liveLogs = new Map<string, string[]>()

const MASK = '••••••'

/** Every stored secret value (all scopes), longest first so overlapping values mask fully. */
export function secretValues(secrets: SecretMap): string[] {
  const values = Object.values(secrets).flatMap((scope) => Object.values(scope))
  return [...new Set(values.filter((v) => v.length >= 4))].sort((a, b) => b.length - a.length)
}

export function redact(text: string, values: string[]): string {
  let out = text
  for (const v of values) out = out.split(v).join(MASK)
  return out
}

export class DeployRun {
  readonly record: DeployRecord
  private sections = new Map<string, string[]>()

  constructor(
    private readonly sys: System,
    private readonly journal: Journal,
    workload: string,
    private readonly secrets: () => string[],
  ) {
    const at = sys.now().toISOString()
    this.record = { id: randomUUID(), workload, release: null, status: 'running', stage: 'fetching', stages: [], startedAt: at, endedAt: null, error: null }
    journal.deploys.push(this.record)
    const mine = journal.deploys.filter((d) => d.workload === workload)
    if (mine.length > KEEP_PER_WORKLOAD) {
      const drop = new Set(mine.slice(0, mine.length - KEEP_PER_WORKLOAD).map((d) => d.id))
      journal.deploys = journal.deploys.filter((d) => !drop.has(d.id))
    }
    liveLogs.set(this.record.id, [])
  }

  stage(stage: DeployStage): void {
    if (this.record.stages.at(-1)?.stage === stage) return
    this.record.stage = stage
    this.record.stages.push({ stage, at: this.sys.now().toISOString() })
  }

  /** Append text to a named section (build steps), or replace it (the candidate's journal). */
  log(section: string, text: string, mode: 'append' | 'replace' = 'append'): void {
    const lines = redact(text, this.secrets()).replace(/\r/g, '').split('\n')
    const prev = mode === 'append' ? (this.sections.get(section) ?? []) : []
    this.sections.set(section, [...prev, ...lines].slice(-LOG_LINES))
    liveLogs.set(this.record.id, this.lines())
  }

  lines(): string[] {
    return [...this.sections.values()].flat().slice(-LOG_LINES)
  }

  tail(n: number): string {
    return this.lines().slice(-n).join('\n')
  }

  async succeed(release: string): Promise<void> {
    this.record.release = release
    this.stage('live')
    this.record.status = 'live'
    await this.end()
  }

  async fail(error: string): Promise<void> {
    this.record.error = redact(error.split('\n')[0] ?? error, this.secrets())
    this.stage('failed')
    this.record.status = 'failed'
    await this.end()
  }

  private async end(): Promise<void> {
    this.record.endedAt = this.sys.now().toISOString()
    await this.sys.writeFile(deployLogPath(this.record.id), this.lines().join('\n') + '\n', 0o600)
    liveLogs.delete(this.record.id)
  }
}

export async function readDeployLog(sys: System, id: string): Promise<string[]> {
  const live = liveLogs.get(id)
  if (live) return live
  const raw = await sys.readFile(deployLogPath(id))
  if (raw === null) return []
  return raw.replace(/\n$/, '').split('\n')
}

/** Removing an app forgets its deploys and their logs too. */
export async function forgetDeploys(sys: System, journal: Journal, name: string): Promise<void> {
  for (const d of journal.deploys.filter((x) => x.workload === name)) {
    await sys.remove(deployLogPath(d.id))
    liveLogs.delete(d.id)
  }
  journal.deploys = journal.deploys.filter((d) => d.workload !== name)
}
