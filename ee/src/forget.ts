import type { Journal } from './journal.ts'

/**
 * Removing an app forgets it: its sealed secrets and its event history go with
 * it, so a later app of the same name starts clean. One company-level event
 * records that the removal happened (who, which app).
 */
export async function forgetWorkload(input: {
  journal: Journal
  secrets: { deleteWorkload(name: string): Promise<void> }
  name: string
  author: string
  now?: () => string
  id?: () => string
}): Promise<void> {
  const { journal, secrets, name, author } = input
  await secrets.deleteWorkload(name)
  journal.events = journal.events.filter((e) => e.workload !== name)
  journal.events.push({
    id: input.id ? input.id() : crypto.randomUUID(),
    time: input.now ? input.now() : new Date().toISOString(),
    type: 'app.removed',
    workload: null,
    message: `app ${name} removed by ${author} (its secrets and history were deleted)`,
    data: {},
  })
}
