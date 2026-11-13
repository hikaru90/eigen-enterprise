import type { CalendarDeps } from './service'
import type { MemberRole } from '$lib/server/auth/user-role'
import { memoryCalendarStore } from './memory-store'

/**
 * Deps over the in-memory store: Olga owns the company, Adam is an admin, Ana
 * and Ben are members. A fixed clock and sequential ids keep tests exact.
 */
export function fixture() {
  const store = memoryCalendarStore()
  const events: Array<{ type: string; principalId: string; payload: Record<string, unknown> }> = []
  const roles: Record<string, MemberRole> = { olga: 'owner', adam: 'admin', ana: 'member', ben: 'member' }
  let clock = Date.parse('2026-11-12T09:00:00Z')
  let ids = 0
  const deps: CalendarDeps = {
    store,
    members: async () => [
      { id: 'olga', name: 'Olga Owner', email: 'olga@example.com' },
      { id: 'adam', name: 'Adam Admin', email: 'adam@example.com' },
      { id: 'ana', name: 'Ana Lind', email: 'ana@example.com' },
      { id: 'ben', name: 'Ben Ode', email: 'ben@example.com' },
    ],
    roleOf: async (userId) => roles[userId] ?? null,
    audit: async (e) => {
      events.push(e)
    },
    now: () => new Date((clock += 1000)),
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  }
  return { deps, store, events }
}

export const user = (userId: string) => ({ kind: 'user' as const, userId })
export const agent = { kind: 'agent' as const, id: 'orchestrator' }

/** A timed event in Berlin on a November 2026 day (CET, UTC+1). */
export const timed = (day: string, from: string, to: string, over: Record<string, unknown> = {}) => ({
  title: 'Planning',
  allDay: false,
  start: `${day}T${from}`,
  end: `${day}T${to}`,
  timeZone: 'Europe/Berlin',
  ...over,
})
