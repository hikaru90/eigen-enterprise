import { describe, expect, it } from 'vitest'
import { InMemoryApprovalStore, StaticApprovalPolicy } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore, ModuleRegistry } from '$lib/kernel/modules'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext } from '$lib/kernel/types'
import { registerModuleTools } from '$lib/kernel/wiring'
import { FakeSes } from './fake-ses'
import { emailManifest } from '../manifest'
import { OWLERY_TOOL_NAMES } from './manifest'
import { OwleryService } from './service'
import { InMemoryOwleryStore, owlerySealKey } from './store'
import { createOwleryTools } from './tools'

const human: ToolContext = { principal: { id: 'owner', kind: 'human', roles: ['admin'] }, requestId: 'r1' }
const agent: ToolContext = { principal: { id: 'agent-1', kind: 'agent', roles: ['agent'] }, requestId: 'r2' }
const mail = { to: 'a@b.co', subject: 'Hi', html: '<p>hi</p>', text: 'hi' }

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
  ses.sent.length = 0
  const activations = new InMemoryActivationStore()
  await activations.set('email', true)
  const modules = new ModuleRegistry(activations)
  // The email module's Owlery slice: only these tools are wired in this spec.
  modules.register({ ...emailManifest, tools: [...OWLERY_TOOL_NAMES] })
  const approvals = new InMemoryApprovalStore()
  const registry = new KernelRegistry({
    eventSink: new InMemoryEventSink(),
    activationStore: activations,
    approvalPolicy: new StaticApprovalPolicy(new Set(['owlery.send_mail'])),
    approvalStore: approvals,
    vcsCommitter: null,
  })
  registerModuleTools(registry, modules, createOwleryTools({ service }))
  return { registry, approvals, ses }
}

describe('owlery tools', () => {
  it('match the manifest', () => {
    const tools = createOwleryTools({ service: { status: async () => ({ configured: false }), send: async () => ({ messageId: null }) } })
    expect(tools.map((t) => t.name)).toEqual([...OWLERY_TOOL_NAMES])
    expect(tools.find((t) => t.name === 'owlery.status')?.auditClass).toBe('read')
    expect(tools.find((t) => t.name === 'owlery.send_mail')?.auditClass).toBe('mutate')
    expect(emailManifest).toMatchObject({ id: 'email', name: 'Email' })
    expect(emailManifest.tools).toEqual(expect.arrayContaining([...OWLERY_TOOL_NAMES]))
    for (const t of tools) expect(t.module).toBe('email')
  })

  it('status is readable by humans and agents', async () => {
    const { registry } = await kernel()
    for (const ctx of [human, agent]) {
      await expect(registry.execute('owlery.status', {}, ctx)).resolves.toMatchObject({ configured: true, sender: 'hello@kindred.test' })
    }
  })

  it("an agent's send waits for the owner's approval, then goes out", async () => {
    const { registry, approvals, ses } = await kernel()
    await expect(registry.execute('owlery.send_mail', mail, agent)).rejects.toMatchObject({ code: 'approval_required' })
    expect(ses.sent).toEqual([])
    const [pending] = await approvals.listPending()
    await approvals.decide(pending!.id, 'approved', 'owner')
    await expect(registry.execute('owlery.send_mail', mail, agent)).resolves.toEqual({ messageId: 'msg-1' })
    expect(ses.sent[0]).toMatchObject({ from: 'hello@kindred.test', to: 'a@b.co' })
  })

  it('a human send is gated the same way (kernel policy is per tool)', async () => {
    const { registry, ses } = await kernel()
    await expect(registry.execute('owlery.send_mail', mail, human)).rejects.toMatchObject({ code: 'approval_required' })
    expect(ses.sent).toEqual([])
  })

  it('rejects malformed mail', async () => {
    const send = createOwleryTools({ service: { status: async () => ({ configured: false }), send: async () => ({ messageId: null }) } })[1]!
    expect(send.inputSchema.safeParse({ ...mail, to: 'nope' }).success).toBe(false)
    expect(send.inputSchema.safeParse({ ...mail, extra: 1 }).success).toBe(false)
  })
})
