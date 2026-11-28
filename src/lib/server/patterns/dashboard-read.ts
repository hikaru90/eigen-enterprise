import type { PatternToolView } from '$lib/kernel/pattern-tools'
import { personRun } from '$lib/server/org/person-run'

/** The dashboard's What's happening card reads dashboard.patterns as the signed-in person (a client of the registry). */
export async function dashboardPatterns(userId: string): Promise<PatternToolView> {
  return personRun<PatternToolView>({ id: userId }, 'dashboard.patterns', {})
}
