import type { SeededIds } from './fixture/seed'
import type { CompanyFixture, MemberKey } from './types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppBoot } from '$lib/server/boot'
import { dropEvalBrainDatabase, recreateEvalBrainDatabase } from './db'

/**
 * Sets up the eval company: a fresh database (db.ts), a fresh state
 * directory (Drive blobs, the company data repo, agent transcripts), the
 * real app boot, then the fixture. App modules are imported only after the
 * environment points at the eval database — their pools read it at load.
 */

/** Env that would send the eval's writes somewhere other than its own state dir. */
const REDIRECTING_ENV = ['DRIVE_STORAGE_DIR', 'COMPANY_DATA_DIR', 'EE_AGENT_STATE_DIR']

export type EvalCompany = {
  boot: AppBoot
  seeded: SeededIds
  anchor: Date
  stateDir: string
  /** Run a registry tool exactly as a chat turn of this member would (see execAsMember). */
  exec: (member: MemberKey, tool: string, input: Record<string, unknown>) => Promise<unknown>
  /** The read/write tool names the brain is offered. */
  surface: string[]
  /** Closes the app's pools, removes the state dir and — with `dropDatabase` — the eval database. */
  tearDown(opts: { dropDatabase: boolean }): Promise<void>
}

export async function setUpEvalCompany(
  f: CompanyFixture,
  opts: {
    anchor: Date
    enrichThoughts: boolean
    /** More app env (e.g. the provider), set before boot. */
    env?: Record<string, string>
    /** A per-run database (the unit gate) instead of ee_eval_brain (the CLI, kept for inspection). */
    databaseName?: string
  },
): Promise<EvalCompany> {
  const testUrl = process.env.DATABASE_URL?.trim()
  if (!testUrl) throw new Error('eval:brain needs DATABASE_URL (the local test Postgres; npm run db:up)')
  for (const key of REDIRECTING_ENV) {
    if (process.env[key]?.trim()) throw new Error(`eval:brain refuses to run with ${key} set: its writes must stay in the eval's own state directory`)
  }
  const stateDir = await mkdtemp(join(tmpdir(), 'ee-eval-brain-'))
  await pointAppEnv({ ...opts.env, DATABASE_URL: await recreateEvalBrainDatabase(testUrl, opts.databaseName), EE_STATE_DIR: stateDir })

  const { bootApp } = await import('$lib/server/boot')
  const boot = await bootApp({ recap: { startTick: false } })
  const { seedCompany } = await import('./fixture/seed')
  const seeded = await seedCompany(f, { anchor: opts.anchor, enrichThoughts: opts.enrichThoughts })
  const { ORCHESTRATOR_AGENT_ID } = await import('../../modules/orchestrator/brain')
  const surface = (await boot.orchestrator.runtime.listAgentTools(ORCHESTRATOR_AGENT_ID)).map((t) => t.name)
  const exec = async (member: MemberKey, tool: string, input: Record<string, unknown>) => execAsMember(boot, seeded.member[member], tool, input)
  const tearDown = async ({ dropDatabase }: { dropDatabase: boolean }) => {
    const { closeAppDbPool } = await import('$lib/server/db')
    const { closeAuthDbPool } = await import('$lib/server/db/auth-db')
    await Promise.all([closeAppDbPool(), closeAuthDbPool()])
    await rm(stateDir, { recursive: true, force: true })
    if (dropDatabase) await dropEvalBrainDatabase(testUrl, opts.databaseName)
  }
  return { boot, seeded, anchor: opts.anchor, stateDir, exec, surface, tearDown }
}

/**
 * The app reads env two ways: `process.env` and SvelteKit's
 * `$env/dynamic/private`, which under Vite is a snapshot object taken when
 * the config loaded (.env included). Both must name the eval database and
 * state dir before any app module is imported.
 */
async function pointAppEnv(values: Record<string, string>): Promise<void> {
  const { env } = await import('$env/dynamic/private')
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value
    ;(env as Record<string, string | undefined>)[key] = value
  }
}

/**
 * The tool-call context of a chat turn (handleAgentChatPost + AgentRuntime):
 * the member's RLS session and tenant scope, the orchestrator principal with
 * its runtime roles, the member as acting user.
 */
export async function execAsMember(boot: AppBoot, userId: string, tool: string, input: Record<string, unknown>): Promise<unknown> {
  const { randomUUID } = await import('node:crypto')
  const { withEvalDb } = await import('../harness/eval-context')
  const { ORCHESTRATOR_PRINCIPAL } = await import('../../modules/orchestrator/brain')
  return withEvalDb(userId, () =>
    boot.kernel.registry.execute(tool, input, {
      principal: { id: ORCHESTRATOR_PRINCIPAL.id, kind: 'agent', roles: [...ORCHESTRATOR_PRINCIPAL.roles] },
      requestId: randomUUID(),
      actingUserId: userId,
    }),
  )
}
