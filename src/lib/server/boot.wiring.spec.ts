import { describe, expect, it } from 'vitest'
import { InMemoryApprovalStore } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import { InMemoryJourneyStore } from '$lib/kernel/playbook'
import type { PrincipalStore } from '$lib/kernel/principals'
import { InMemoryAgentSessionLog } from '$lib/kernel/session-log'
import { buildKernel } from '../../../modules/index'
import { ORCHESTRATOR_AGENT_ID } from '../../../modules/orchestrator/brain'
import { bootApp } from './boot'

/**
 * The REAL production composition (boot.ts → buildKernel → bootstrapOrchestrator
 * → gateway/recap stages) — no stage is mocked. Only the kernel's storage is
 * in-memory (buildKernel's own injection seam), so no DB is needed. Pins the
 * production incident "unknown tool: kernel.module_activate": the web
 * server's kernel never registered the admin tools (only the CLI did).
 */
describe('bootApp — production wiring', () => {
  it('the web kernel carries the admin tools and offers them to the orchestrator', async () => {
    const activations = new InMemoryActivationStore()
    const boot = await bootApp({
      env: {},
      buildKernel: () =>
        buildKernel({
          activations,
          eventSink: new InMemoryEventSink(),
          approvalStore: new InMemoryApprovalStore(),
          principals: {} as PrincipalStore,
          sessionLog: new InMemoryAgentSessionLog(),
          vcsCommitter: null,
        }),
      journeys: new InMemoryJourneyStore(),
      recap: { startTick: false },
    })

    expect(boot.kernel.registry.get('kernel.module_activate')).toBeDefined()
    expect(boot.kernel.registry.get('kernel.module_list')).toBeDefined()

    const offered = (await boot.orchestrator.runtime.listAgentTools(ORCHESTRATOR_AGENT_ID)).map(
      (tool) => tool.name,
    )
    expect(offered).toContain('kernel.module_activate')
    expect(offered).toContain('kernel.module_list')
    // Hosting, GitHub and email are on from the first boot (not only once a settings page opens).
    for (const id of ['substrate', 'github', 'owlery']) expect(await activations.get(id)).toBe(true)
  })
})
