import { describe, expect, it } from 'vitest'
import { InMemoryApprovalStore, StaticApprovalPolicy } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore, ModuleRegistry } from '$lib/kernel/modules'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext } from '$lib/kernel/types'
import { registerModuleTools } from '$lib/kernel/wiring'
import { emailManifest } from '../manifest'
import { FakeSes } from './fake-ses'
import { OWLERY_TOOL_NAMES } from './manifest'
import { OwleryService } from './service'
import { InMemoryOwleryStore, owlerySealKey } from './store'
import { createOwleryTools } from './tools'

const human: ToolContext = { principal: { id: 'owner', kind: 'human', roles: ['admin'] }, requestId: 'r1' }
const agent: ToolContext = { principal: { id: 'agent-1', kind: 'agent', roles: ['agent'] }, requestId: 'r2' }

async function kernel() {
  const ses = new FakeSes().verify('hello@kindred.test')
  const service = new OwleryService({ store: new InMemoryOwleryStore(), key: () => owlerySealKey('k'), ses: ses.factory })
  await service.saveVerified({
    region: 'eu-central-1',
    accessKeyId: 'AKIA',
    secretAccessKey: 'secret',
    emailFrom: 'hello@kindred.test',
    testRecipient: 'owner@kindred.test',
    updatedBy: 'owner',
  })
  const activations = new InMemoryActivationStore()
  await activations.set('email', true)
  const modules = new ModuleRegistry(activations)
  // The email module's Owlery slice: only these tools are wired in this spec.
  modules.register({ ...emailManifest, tools: [...OWLERY_TOOL_NAMES] })
  const registry = new KernelRegistry({
    eventSink: new InMemoryEventSink(),
    activationStore: activations,
    approvalPolicy: new StaticApprovalPolicy(new Set()),
    approvalStore: new InMemoryApprovalStore(),
    vcsCommitter: null,
  })
  registerModuleTools(registry, modules, createOwleryTools({ service }))
  return { registry }
}

describe('owlery tools', () => {
  it('match the manifest: status only — sending is email.send_mail (E4 removed owlery.send_mail)', () => {
    const tools = createOwleryTools({ service: { status: async () => ({ configured: false }) } })
    expect(tools.map((t) => t.name)).toEqual(['owlery.status'])
    expect([...OWLERY_TOOL_NAMES]).toEqual(['owlery.status'])
    expect(tools[0]?.auditClass).toBe('read')
    expect(emailManifest).toMatchObject({ id: 'email', name: 'Email' })
    expect(emailManifest.tools.slice(0, 2)).toEqual(['email.send_mail', 'owlery.status'])
    // The platform tools (domains, senders, logs, suppression) follow; no other owlery.* tool.
    expect(emailManifest.tools.filter((t) => t.startsWith('owlery.'))).toEqual(['owlery.status'])
    for (const t of tools) expect(t.module).toBe('email')
  })

  it('status is readable by humans and agents', async () => {
    const { registry } = await kernel()
    for (const ctx of [human, agent]) {
      await expect(registry.execute('owlery.status', {}, ctx)).resolves.toMatchObject({ configured: true, sender: 'hello@kindred.test' })
    }
  })
})
