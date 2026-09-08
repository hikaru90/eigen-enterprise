import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { eq } from 'drizzle-orm'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { isUserProviderReady } from '$lib/server/llm/provider-ready'
import { isByokUiEnabled } from '$lib/server/settings/byok-ui'

export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) {
    throw redirect(302, '/login')
  }

  const userId = event.locals.user.id
  const [authUser] = await authDb
    .select({ accountKind: user.accountKind })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)

  const isHarness = authUser?.accountKind === 'harness'
  const providerReady = await isUserProviderReady(userId)

  return {
    // First-run gate: without a working provider there is no product — the page IS the
    // setup wizard. Harness accounts bypass (they exist for automated verification).
    needsOnboarding: !isHarness && !providerReady,
    byokUiEnabled: isByokUiEnabled(),
  }
}
