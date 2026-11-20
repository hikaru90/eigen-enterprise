import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// Hermetic: building the registry reads tool descriptors only; no handler, env or DB is touched.
vi.mock('$env/dynamic/private', () => ({ default: {}, env: {} }))

import { registerAdminTools } from '$lib/kernel/admin-bootstrap'
import { agentAdminManifest, createAgentAdminTools } from '$lib/kernel/agent-admin'
import type { AgentRuntime } from '$lib/kernel/agent-runtime'
import { InMemoryApprovalModeStore, InMemoryApprovalStore } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import type { SettingsPort } from '$lib/kernel/settings-tools'
import { registerModuleTools } from '$lib/kernel/wiring'
import { buildKernel } from '../../../modules/index'
import { scanRoutes } from './route-scan'
import { DEBT_CEILING, debtSummaryMarkdown, parityKind, UI_PARITY } from './ui-parity'

/**
 * The registry-first gate (plan/phase-company-brain.md CB4; AGENTS.md "No
 * UI-only actions"). Static: the routes are parsed, never served; the
 * registry is built with every module and the kernel admin, settings and
 * agent-admin tools, in memory.
 */

const SRC = path.resolve(import.meta.dirname, '../..')

/** The production registry surface (as tools-list-contract.spec.ts builds it). */
async function productionRegistry() {
  const kernel = buildKernel({
    activations: new InMemoryActivationStore(),
    eventSink: new InMemoryEventSink(),
    approvalStore: new InMemoryApprovalStore(),
    approvalMode: new InMemoryApprovalModeStore('ask'),
    vcsCommitter: null,
  })
  const notInAListing = async (): Promise<never> => {
    throw new Error('the parity gate never calls the settings port')
  }
  const settings: SettingsPort = {
    modelFor: notInAListing,
    person: notInAListing,
    read: notInAListing,
    apply: notInAListing,
  }
  await registerAdminTools(kernel, { settings })
  kernel.modules.register(agentAdminManifest)
  registerModuleTools(kernel.registry, kernel.modules, createAgentAdminTools({ runtime: {} as AgentRuntime }))
  return {
    tools: new Set(kernel.registry.list().map((t) => t.name)),
    modules: new Set(kernel.modules.list().map((m) => m.id)),
  }
}

const scanned = scanRoutes(SRC)
const mapped = Object.keys(UI_PARITY)

describe('registry-first: every mutating entry point is mapped (src/lib/kernel/ui-parity.ts)', () => {
  it('finds the mutating entry points of the app', () => {
    // A sanity floor: a scanner that silently finds nothing would pass every check below.
    expect(scanned.length).toBeGreaterThan(200)
  })

  it('maps every mutating entry point (a new one is a registry tool, or declared)', () => {
    const unmapped = scanned.filter((key) => !(key in UI_PARITY))
    expect(
      unmapped,
      'New UI-only actions are not allowed: give each a registry tool and map it as { tool }, or declare it in ui-parity.ts',
    ).toEqual([])
  })

  it('names no entry point that no longer exists', () => {
    const live = new Set(scanned)
    expect(
      mapped.filter((key) => !live.has(key)),
      'Remove these keys from ui-parity.ts (and lower DEBT_CEILING for debt ones)',
    ).toEqual([])
  })

  it('maps tools only to tools the registry really has (all modules registered)', async () => {
    const { tools } = await productionRegistry()
    const missing = Object.entries(UI_PARITY)
      .filter(([, entry]) => 'tool' in entry && !tools.has(entry.tool))
      .map(([key, entry]) => `${key} → ${'tool' in entry ? entry.tool : ''}`)
    expect(missing).toEqual([])
  })

  it('owes debt only to registered modules, each with a note', async () => {
    const { modules } = await productionRegistry()
    const bad = Object.entries(UI_PARITY)
      .filter(([, entry]) => 'debt' in entry && (!modules.has(entry.debt) || entry.note.trim() === ''))
      .map(([key]) => key)
    expect(bad).toEqual([])
  })

  it('gives every humanOnly, transport and noEffect entry a reason', () => {
    const silent = Object.entries(UI_PARITY)
      .filter(([, entry]) => {
        const reason = 'humanOnly' in entry ? entry.humanOnly : 'transport' in entry ? entry.transport : 'noEffect' in entry ? entry.noEffect : null
        return reason !== null && reason.trim() === ''
      })
      .map(([key]) => key)
    expect(silent).toEqual([])
  })

  it('only shrinks debt: the debt count is exactly DEBT_CEILING', () => {
    const debt = Object.values(UI_PARITY).filter((entry) => parityKind(entry) === 'debt').length
    expect(debt, `Debt may only shrink. Above the ceiling: give the new action a registry tool. Below it: lower DEBT_CEILING to ${debt}.`).toBe(DEBT_CEILING)
  })

  it('keeps plan/parity-debt.md generated from the map', async () => {
    await expect(debtSummaryMarkdown()).toMatchFileSnapshot(path.resolve(SRC, '../plan/parity-debt.md'))
  })
})
