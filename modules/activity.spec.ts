import { describe, expect, it } from 'vitest'
import type { ToolDescriptor } from '$lib/kernel/types'
import { InMemoryApprovalModeStore, InMemoryApprovalStore } from '$lib/kernel/approvals'
import { registerAdminTools } from '$lib/kernel/admin-bootstrap'
import { createAgentAdminTools } from '$lib/kernel/agent-admin'
import type { AgentRuntime } from '$lib/kernel/agent-runtime'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import type { AllowlistStore } from '$lib/kernel/gateway'
import { buildKernel } from './index'
import { createEmailTools } from './email/tools'
import { createAllowlistAdminTools } from './orchestrator/allowlist-tools'
import { createRecapRunNowTool } from './recap/tools'
import type { RecapDeps } from './recap/types'
import { createSubstrateTools } from './website/hosting/tools'
import { createWebsiteTools } from './website/tools'

/** Every tool the real boot registers (buildKernel + admin + the boot-time extras). */
async function allRegisteredTools(): Promise<ToolDescriptor[]> {
  const kernel = buildKernel({
    activations: new InMemoryActivationStore(),
    eventSink: new InMemoryEventSink(),
    approvalStore: new InMemoryApprovalStore(),
    approvalMode: new InMemoryApprovalModeStore('ask'),
    vcsCommitter: null,
  })
  await registerAdminTools(kernel)
  return [
    ...kernel.registry.list(),
    ...createAgentAdminTools({ runtime: {} as AgentRuntime }),
    ...createAllowlistAdminTools({} as AllowlistStore),
    createRecapRunNowTool({} as RecapDeps),
  ]
}

describe('every non-read tool says in plain words what it did', () => {
  it('declares an activity on each registered mutate/external tool', async () => {
    const tools = await allRegisteredTools()
    const nonRead = tools.filter((t) => t.auditClass !== 'read')
    expect(nonRead.length).toBeGreaterThan(30)
    const missing = nonRead.filter((t) => typeof t.activity !== 'function').map((t) => t.name)
    expect(missing).toEqual([])
  })
})

const mail = {
  to: 'ada@example.com',
  subject: 'Your reset token is tok_live_123',
  html: '<p>password: hunter2</p>',
  text: 'password: hunter2 key=sk_live_abc',
}

describe('activity never carries secrets', () => {
  for (const [name, tools] of [
    ['email.send_mail', createEmailTools({ mail: { send: async () => ({ messageId: null }) } })],
  ] as const) {
    it(`${name} names only the recipient`, () => {
      const tool = tools.find((t) => t.name === name)!
      const sentence = tool.activity!(mail, { messageId: 'm' })
      expect(sentence).toBe('Sent an email to ada@example.com')
      for (const secret of ['tok_live_123', 'hunter2', 'sk_live_abc', 'password']) {
        expect(sentence).not.toContain(secret)
      }
    })
  }

  it('substrate.secret_set names the secret, never its value', () => {
    const tool = createSubstrateTools({ client: {} as never }).find((t) => t.name === 'substrate.secret_set')!
    const sentence = tool.activity!({ workload: 'shop', name: 'STRIPE_KEY', value: 'sk_live_xyz' }, undefined)
    expect(sentence).toBe('Set the secret STRIPE_KEY for the app “shop”')
    expect(sentence).not.toContain('sk_live_xyz')
  })
})

describe('website activities use the page title, or the slug as-is', () => {
  const tools = createWebsiteTools({ store: {} as never, origin: () => 'http://x' })
  const publish = tools.find((t) => t.name === 'website.publish_page')!
  const page = { slug: 'about', title: 'About', visibility: 'public' }

  it('publish public / private with the title from the output', () => {
    expect(publish.activity!({ slug: 'about', visibility: 'public' }, page)).toBe('Published the About page')
    expect(publish.activity!({ slug: 'about', visibility: 'private' }, page)).toBe('Made the About page private')
  })

  it('a failed publish (no output) quotes the slug and invents no title', () => {
    expect(publish.activity!({ slug: 'about', visibility: 'public' }, undefined)).toBe('Published the page “about”')
  })

  it('create uses the title from the input', () => {
    const create = tools.find((t) => t.name === 'website.create_page')!
    expect(create.activity!({ slug: 'contact', title: 'Contact', body: 'b' }, undefined)).toBe(
      'Created the Contact page',
    )
  })
})
