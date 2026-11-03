import type { MessagesDeps } from './service'
import { FakeAccessPort } from './access-port'
import { MemoryDirectory, MemoryMessagesStore } from './memory-store'

/** Owner + two members, a fake access port and a ticking clock. */
export function fixture() {
  const store = new MemoryMessagesStore()
  const access = new FakeAccessPort()
  const directory = new MemoryDirectory([
    { id: 'owner', name: 'Olga Owner', email: 'olga@co.test' },
    { id: 'bea', name: 'Bea Member', email: 'bea@co.test' },
    { id: 'carl', name: 'Carl Member', email: 'carl@co.test' },
  ])
  for (const [id, role] of [
    ['owner', 'owner'],
    ['bea', 'member'],
    ['carl', 'member'],
  ] as const) {
    directory.roles.set(id, role)
    access.roles.set(id, role)
  }
  let t = Date.UTC(2026, 10, 3, 9, 0, 0)
  let n = 0
  const deps: MessagesDeps = {
    store,
    access,
    directory,
    now: () => new Date((t += 1000)),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  }
  return { store, access, directory, deps }
}
