import type { ContributeAudit, ContributeDeps } from './service'
import type { Directory } from './store'
import { dbContributeStore } from './db-store'

/**
 * Live wiring: the DB store over the app pool (company-level tables, no RLS),
 * the members table for names, the gateway for the judge (on the company's AI
 * provider — the owner's — not the proposer's own settings), the company name
 * from the founding journey, and kernel events for the activity feed.
 */

let depsPromise: Promise<ContributeDeps> | null = null

const directory: Directory = {
  async names() {
    const { dbMemberStore } = await import('$lib/server/members/db-store')
    return new Map((await dbMemberStore.listMembers()).map((m) => [m.id, m.name || m.email]))
  },
}

const kernelAudit: ContributeAudit = async ({ type, principalId, payload }) => {
  const { appKernel } = await import('$lib/server/boot')
  const { emitKernelEvent } = await import('$lib/kernel/events')
  const { moduleSource } = await import('$lib/kernel/cloudevents')
  const kernel = await appKernel()
  await emitKernelEvent(kernel.eventSink, { type, principalId, source: moduleSource('contribute'), payload })
}

export function contributeDeps(): Promise<ContributeDeps> {
  depsPromise ??= (async (): Promise<ContributeDeps> => {
    const { appSql, createScopedDrizzle } = await import('$lib/server/db')
    return {
      store: dbContributeStore(createScopedDrizzle(appSql)),
      directory,
      // The judge runs on the company's AI provider (the owner's), whoever proposes.
      chat: async (input) => {
        const { llmChatCompletion } = await import('$lib/server/llm/llm-client')
        const { onCompanyProvider } = await import('$lib/server/llm/company-provider')
        return onCompanyProvider(() => llmChatCompletion(input))
      },
      companyName: async () => {
        const { foundingCompanyName } = await import('$lib/server/overview/sources')
        return foundingCompanyName()
      },
      audit: kernelAudit,
    }
  })().catch((err) => {
    depsPromise = null
    throw err
  })
  return depsPromise
}
