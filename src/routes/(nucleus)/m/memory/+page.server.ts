import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'

/**
 * /m/memory has no page of its own any more (plan/concept-memory-one-door.md,
 * decision 1): the Overview tab is gone and Memory lands on Tasks, whose
 * to-do and overdue views list every open task with its project and Delete.
 * A temporary redirect, so the bare URL can become a page again later.
 */
export const load: PageServerLoad = () => {
  redirect(307, '/m/memory/tasks')
}
