import type { CompanyContext } from './turns'
import type { JourneyState } from '$lib/kernel/playbook'

/**
 * What a co-worker's prompt says about the company (plan/phase-ai-coworkers.md
 * §5 "company profile and brand voice"): the name every page shows (Settings →
 * Company, else the founding interview's), and the founding interview's
 * answers to "what the company does" (positioning) and its tone of voice.
 * Absent answers stay absent (null): the prompt says the company is not named
 * or leaves the line out — nothing is made up. The brand module's guideline
 * sets are not copied in; a co-worker reads them with the brand.* tools.
 *
 * Read in the co-worker's own database session (a turn has no request).
 */
export async function liveCompanyContext(coworkerId: string): Promise<CompanyContext> {
  const [{ foundingCompanyName }, { getDb, withDbUser }, { kernelJourneys }, { WEBSITE_FOUNDING_JOURNEY }, { desc, eq }] = await Promise.all([
    import('$lib/server/overview/sources'),
    import('$lib/server/db'),
    import('$lib/server/db/journey.schema'),
    import('../../../../modules/orchestrator/brain'),
    import('drizzle-orm'),
  ])
  return withDbUser(coworkerId, async () => {
    const [journey] = await getDb()
      .select({ state: kernelJourneys.state })
      .from(kernelJourneys)
      .where(eq(kernelJourneys.kind, WEBSITE_FOUNDING_JOURNEY.kind))
      .orderBy(desc(kernelJourneys.createdAt))
      .limit(1)
    const answers: JourneyState['answers'] = journey?.state.answers ?? {}
    const answer = (key: string) => answers[key]?.trim() || null
    return { name: await foundingCompanyName(), profile: answer('positioning'), brandVoice: answer('tone') }
  })
}
