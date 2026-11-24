import type { ModuleHubDeps } from './service'
import type { SummarizeDeps } from './summarize'
import type { ModuleSummaryDto } from './types'
import { z } from 'zod'
import { env } from '$lib/server/env/private-env'
import { MODULE_HUB_SUMMARY_JOB } from '$lib/server/job-queue/constants'
import { bundleDir, fsBundleStorage } from './bundles'
import { lockCatalog } from './checks'
import { dbModuleHubStore } from './db-store'
import { MODULE_HUB_MODULE_ID } from './manifest'
import { summarizeVersion } from './summarize'

/**
 * Live wiring of the module hub (plan/phase-upgrades-u2.md §7), on the central
 * box: the DB store over the app pool; bundles under $EE_STATE_DIR/module-hub/bundles;
 * receipts signed with the MODULE_HUB_SIGNING_KEY ee secret and naming this
 * box's ORIGIN; summaries as a job-queue job through the gateway, on the
 * company's AI provider, attributed to the owner. Everything resolves at use
 * and fails loud when unset — no defaults. The request authentication (the
 * contribute hub's) is composed in src/lib/server/module-hub/http.ts: no
 * module imports another.
 */

/** Everything of the hub's deps but the request authentication. */
export type ModuleHubParts = Omit<ModuleHubDeps, 'authenticate'>

function signingKey(): string {
  const key = env.MODULE_HUB_SIGNING_KEY?.trim()
  if (!key) throw new Error('the module hub signing key is not set (MODULE_HUB_SIGNING_KEY, an ee secret on the hub box): no receipt can be issued')
  return key
}

function origin(): string {
  const raw = env.ORIGIN?.trim()
  if (!raw) throw new Error('ORIGIN is not set, so the module hub cannot name itself in a receipt')
  return new URL(raw).origin
}

async function enqueueSummary(bundleSha256: string): Promise<void> {
  const { companyOwnerId } = await import('$lib/server/llm/company-provider')
  const owner = await companyOwnerId()
  if (!owner) throw new Error('the company has no owner, so no module summary can be queued')
  const { enqueueUserJob } = await import('$lib/server/job-queue/enqueue')
  await enqueueUserJob({
    userId: owner,
    jobType: MODULE_HUB_SUMMARY_JOB,
    runAfter: new Date(),
    dedupeKey: `module-hub-summary:${bundleSha256}`,
    payload: { bundleSha256 },
  })
}

let depsPromise: Promise<ModuleHubParts> | null = null

export function moduleHubDeps(): Promise<ModuleHubParts> {
  depsPromise ??= (async (): Promise<ModuleHubParts> => {
    const { appSql, createScopedDrizzle } = await import('$lib/server/db')
    return {
      now: () => Date.now(),
      store: dbModuleHubStore(createScopedDrizzle(appSql)),
      bundles: fsBundleStorage(bundleDir(env.EE_STATE_DIR)),
      signingKey,
      origin,
      catalog: lockCatalog(),
      enqueueSummary,
    }
  })().catch((err) => {
    depsPromise = null
    throw err
  })
  return depsPromise
}

/** Whether this install is the module hub (the owner switched the module on). */
export async function moduleHubActive(): Promise<boolean> {
  const { appKernel } = await import('$lib/server/boot')
  return (await appKernel()).activations.get(MODULE_HUB_MODULE_ID)
}

async function summarizeDeps(): Promise<SummarizeDeps> {
  const deps = await moduleHubDeps()
  const { llmChatCompletion } = await import('$lib/server/llm/llm-client')
  const { companyOwnerId, onCompanyProvider } = await import('$lib/server/llm/company-provider')
  const { withDbUser } = await import('$lib/server/db')
  return {
    store: deps.store,
    bundles: deps.bundles,
    chat: (input) => llmChatCompletion(input),
    runAsOwner: async (fn) => {
      const owner = await companyOwnerId()
      if (!owner) throw new Error('the company has no owner, so there is no company AI provider to summarise with')
      return withDbUser(owner, () => onCompanyProvider(() => fn(owner)))
    },
    now: () => new Date(),
  }
}

/** module_hub.summarize: write the summary now. */
export async function summarizeNow(bundleSha256: string): Promise<ModuleSummaryDto> {
  return summarizeVersion(await summarizeDeps(), bundleSha256)
}

const jobPayload = z.object({ bundleSha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict()

/** The job-queue job queued after a publish. */
export async function processModuleHubSummaryJob(job: { payload: Record<string, unknown> }): Promise<void> {
  const parsed = jobPayload.safeParse(job.payload)
  if (!parsed.success) throw new Error(`module hub summary job has no valid bundleSha256: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
  await summarizeNow(parsed.data.bundleSha256)
}
