import type { ModuleManifest } from '$lib/kernel/modules'

export const CALENDAR_MODULE_ID = 'calendar'

/** Read-only for now; `calendar.propose_event` (approval-gated) comes with a later slice. */
export const CALENDAR_TOOL_NAMES = ['calendar.list', 'calendar.free_busy'] as const

/**
 * Calendar (plan/calendar.md): each member's own calendar — events, recurring
 * series, guests — and colleagues' availability. Colleagues see the title of
 * a company-visible event, "Busy" for a busy one and "Out of office" for a
 * private one; the owner and admins see no more. An official plugin (seeded
 * on once; Settings → Plugins switches it off); the people's surface is
 * /m/calendar, the agent's is these tools.
 */
export const calendarManifest: ModuleManifest = {
  id: CALENDAR_MODULE_ID,
  name: 'Calendar',
  version: '0.1.0',
  description: 'Your appointments by day, week and month, and when colleagues are free — busy, out of office or in a company meeting.',
  tools: [...CALENDAR_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent'] },
}
