import { randomUUID } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import type { ToolContext } from '$lib/kernel/types'
import { resolveCompanyIdentity, type CompanyIdentity } from '$lib/server/company/service'
import { companyProfileStore } from '$lib/server/company/store'
import { getDb } from '$lib/server/db'
import { kernelJourneys } from '$lib/server/db/journey.schema'
import { WEBSITE_FOUNDING_JOURNEY } from '../../../../modules/orchestrator/brain'
import { websiteStatusFrom } from '../../../../modules/orchestrator/onboarding-context'
import { owleryResultSource, websiteResultSource, type ResultSource } from './overview'

/**
 * The wired result sources (module id → read-only source) shared by
 * /overview and /m/[moduleId], plus the signed-in human's tool context.
 */

async function latestFoundingJourney() {
  const [journey] = await getDb()
    .select({ status: kernelJourneys.status, state: kernelJourneys.state })
    .from(kernelJourneys)
    .where(eq(kernelJourneys.kind, WEBSITE_FOUNDING_JOURNEY.kind))
    .orderBy(desc(kernelJourneys.createdAt))
    .limit(1)
  return journey ?? null
}

export function overviewResultSources(): Record<string, ResultSource> {
  return {
    website: websiteResultSource(async () =>
      websiteStatusFrom((await latestFoundingJourney())?.status ?? null),
    ),
    // Email = Owlery + transactional send (platform step 1); keyed by module id.
    email: owleryResultSource,
  }
}

/** The company name the owner gave in the founding interview; null until given. */
async function foundingInterviewName(): Promise<string | null> {
  const name = (await latestFoundingJourney())?.state?.answers?.company_name?.trim()
  return name ? name : null
}

/**
 * The company's name and logo (src/lib/server/company/service.ts): the name
 * set in Settings → Company, else the founding interview's; the logo from
 * Settings → Company.
 */
export async function companyIdentity(): Promise<CompanyIdentity> {
  return resolveCompanyIdentity({ store: companyProfileStore(), interviewName: foundingInterviewName })
}

/**
 * The company's name — the one every page shows (shell, members, invites, the
 * "not a member" message, the unclaimed page, the installed app): the name set
 * in Settings → Company, else the one the owner gave in the founding
 * interview; null until named.
 */
export async function foundingCompanyName(): Promise<string | null> {
  return (await companyIdentity()).name
}

export function humanContext(userId: string, isAdmin: boolean): ToolContext {
  return {
    principal: { id: userId, kind: 'human', roles: isAdmin ? ['admin'] : [] },
    requestId: randomUUID(),
  }
}
