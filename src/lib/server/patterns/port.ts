import type { PatternsPort } from '$lib/kernel/pattern-tools'
import { liveModuleActivity, livePatternDeps } from './live'
import { patternDigestDue, patternsFor, refreshPatternDigest } from './service'

/** The live port behind dashboard.patterns and dashboard.patterns_refresh. */
export const livePatternsPort: PatternsPort = {
  view: async (roles) => {
    const deps = await livePatternDeps()
    const latest = await deps.latest()
    const moduleActive = await liveModuleActivity(latest?.items.map((i) => i.module) ?? [])
    return patternsFor({ latest: async () => latest }, { roles, moduleActive })
  },
  refresh: async () => {
    await refreshPatternDigest(await livePatternDeps())
  },
}

/** The background job: a new digest once the latest is a day old. */
export async function tickPatternDigest(): Promise<void> {
  const deps = await livePatternDeps()
  if (await patternDigestDue(deps)) await refreshPatternDigest(deps)
}
