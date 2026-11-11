import type { OverviewAction } from '$lib/server/overview/overview'

export type ActionGroup = { label: string; actions: OverviewAction[] }

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`

/**
 * The dashboard's Recent activity, grouped by local calendar day (Today,
 * Yesterday, then the date). Input order (newest first) is kept.
 */
export function groupActionsByDay(actions: readonly OverviewAction[], now: Date): ActionGroup[] {
  const today = dayKey(now)
  const yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
  const groups: ActionGroup[] = []
  for (const action of actions) {
    const at = new Date(action.at)
    const key = dayKey(at)
    const label = key === today ? 'Today' : key === yesterday ? 'Yesterday' : dateFormat.format(at)
    const last = groups.at(-1)
    if (last && last.label === label) last.actions.push(action)
    else groups.push({ label, actions: [action] })
  }
  return groups
}
