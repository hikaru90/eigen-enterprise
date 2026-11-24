import type { CoreApiLock, LockedTool } from '../lock'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { CORE_EVENTS } from '$lib/kernel/event-catalog'
import { CORE_UI_SLOTS } from '$lib/kernel/ui-slots'
import { APPROVAL_REQUIRED_TOOLS } from '../../modules/index'
import { diffContracts } from '../classify'
import { composeContractKernel } from '../compose'
import { CORE_API_VERSION } from '../core-api-version'
import { parseLock, snapshotContract } from '../lock'

/**
 * The core contract test suite (plan/phase-upgrades.md U1): a core satisfies
 * `contracts/core-api.lock.json` when every locked tool, event and UI slot is
 * there with a compatible shape (structurally, the gate's classifier: nothing
 * removed, no input narrowed, no output widened). Runs in the unit run
 * against the in-process registry — the production composition, in memory.
 */

const lockPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'core-api.lock.json')
const lock: CoreApiLock = parseLock(readFileSync(lockPath, 'utf8'), lockPath)
const empty = { events: [], uiSlots: [] }

let current: CoreApiLock

beforeAll(async () => {
  const kernel = await composeContractKernel()
  current = snapshotContract({
    coreApi: CORE_API_VERSION,
    tools: kernel.registry.list(),
    gated: APPROVAL_REQUIRED_TOOLS,
    events: CORE_EVENTS,
    uiSlots: CORE_UI_SLOTS,
  })
})

describe('core-api conformance: the version', () => {
  it(`the core implements core-api ${lock.coreApi.split('.')[0]}.x (same major, not older)`, () => {
    expect(CORE_API_VERSION.split('.')[0]).toBe(lock.coreApi.split('.')[0])
  })
})

describe('core-api conformance: tools', () => {
  it.each(lock.tools.map((tool) => [tool.name, tool] as const))(
    '%s exists with a compatible shape',
    (name, locked: LockedTool) => {
      const tool = current.tools.find((t) => t.name === name)
      expect(tool, `${name} is in the lock but not registered`).toBeDefined()
      const breaking = diffContracts(
        { coreApi: lock.coreApi, tools: [locked], ...empty },
        { coreApi: lock.coreApi, tools: [tool as LockedTool], ...empty },
      ).filter((c) => c.kind === 'breaking')
      expect(breaking).toEqual([])
    },
  )
})

describe('core-api conformance: events and UI slots', () => {
  it('every locked event is still in the core event catalog, from the same emitter', () => {
    for (const event of lock.events) {
      expect(CORE_EVENTS[event.type as keyof typeof CORE_EVENTS], event.type).toEqual({
        module: event.module,
        payload: event.payload,
      })
    }
  })

  it('every locked UI slot is still offered', () => {
    const offered = CORE_UI_SLOTS.map((slot) => slot.name)
    expect(lock.uiSlots.filter((slot) => !offered.includes(slot.name))).toEqual([])
  })
})
