import type { CoreApiLock, LockedTool } from './lock'
import { describe, expect, it } from 'vitest'
import { checkLock, LOCK_PATH, SDK_PATH, writeLock, type GateFiles } from './gate'
import { serializeLock } from './lock'
import { generateSdk } from './sdk-gen'

function memoryFiles(
  initial: Record<string, string> = {},
): GateFiles & { store: Map<string, string> } {
  const store = new Map(Object.entries(initial))
  return { store, read: (p) => store.get(p) ?? null, write: (p, t) => void store.set(p, t) }
}

const t = (name: string): LockedTool => ({
  name,
  module: 'x',
  auditClass: 'read',
  permission: { roles: ['member'] },
  approval: { risk: null, always: false, gated: false },
  input: { type: 'object', properties: {}, required: [], additionalProperties: false },
  output: null,
})

const lockOf = (...names: string[]): CoreApiLock => ({
  coreApi: '1.0.0',
  tools: names.map(t),
  events: [],
  uiSlots: [],
})
const committed = (lock: CoreApiLock) =>
  memoryFiles({
    [LOCK_PATH]: serializeLock(lock),
    [SDK_PATH]: generateSdk(JSON.parse(serializeLock(lock))),
  })
const base = { deprecations: [], release: '0.5.40', today: '2026-11-24' }

describe('contract:check', () => {
  it('passes when the lock and the SDK are what the working tree generates', () => {
    expect(
      checkLock({ ...base, current: lockOf('x.a'), files: committed(lockOf('x.a')) }),
    ).toMatchObject({ ok: true, problems: [] })
  })

  it('an additive change is fine but the stale lock fails with the command to run', () => {
    const result = checkLock({
      ...base,
      current: lockOf('x.a', 'x.b'),
      files: committed(lockOf('x.a')),
    })
    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([expect.stringMatching(/stale.*run npm run contract:lock/)])
  })

  it('a breaking change fails as a breaking change, not only as staleness', () => {
    const result = checkLock({ ...base, current: lockOf(), files: committed(lockOf('x.a')) })
    expect(result.problems.some((p) => p.includes('breaking change tool:x.a'))).toBe(true)
  })

  it('a hand-edited SDK fails', () => {
    const files = committed(lockOf('x.a'))
    files.store.set(SDK_PATH, `${files.store.get(SDK_PATH)}// edited\n`)
    expect(checkLock({ ...base, current: lockOf('x.a'), files }).problems).toEqual([
      expect.stringMatching(/sdk\/core-api\.ts is not what the lock generates/),
    ])
  })

  it('a missing lock fails loud', () => {
    expect(checkLock({ ...base, current: lockOf('x.a'), files: memoryFiles() }).problems).toEqual([
      expect.stringMatching(/missing: run npm run contract:lock/),
    ])
  })
})

describe('contract:lock', () => {
  it('records an additive change (lock and SDK), after which the check passes', () => {
    const files = committed(lockOf('x.a'))
    expect(writeLock({ ...base, current: lockOf('x.a', 'x.b'), files }).ok).toBe(true)
    expect(checkLock({ ...base, current: lockOf('x.a', 'x.b'), files }).ok).toBe(true)
    expect(files.store.get(SDK_PATH)).toContain('"x.b"')
  })

  it('refuses to record a breaking change the gate refuses, and writes nothing', () => {
    const files = committed(lockOf('x.a'))
    const before = new Map(files.store)
    const result = writeLock({ ...base, current: lockOf(), files })
    expect(result.ok).toBe(false)
    expect(result.problems.join('\n')).toContain('tool:x.a')
    expect(files.store).toEqual(before)
  })

  it('bootstraps the first lock', () => {
    const files = memoryFiles()
    expect(writeLock({ ...base, current: lockOf('x.a'), files }).ok).toBe(true)
    expect(files.store.get(LOCK_PATH)).toBe(serializeLock(lockOf('x.a')))
  })
})
