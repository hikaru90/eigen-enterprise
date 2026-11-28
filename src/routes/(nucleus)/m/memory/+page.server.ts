import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'

/**
 * /m/memory has no page of its own any more (plan/concept-memory-one-door.md,
 * decision 1): the Overview tab is gone. Memory's front page is What the
 * brain knows (wish f3fc516e), at its existing /m/memory/capture URL.
 * A temporary redirect, so the bare URL can become a page again later.
 */
export const load: PageServerLoad = () => {
  redirect(307, '/m/memory/capture')
}
