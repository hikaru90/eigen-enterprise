import type { ToolContext } from './types'
import { describe, expect, it, vi } from 'vitest'
import { InMemoryApprovalModeStore, InMemoryApprovalStore, ModeAwareApprovalPolicy } from './approvals'
import { createDecisionTools, KERNEL_DECISION_TOOL_NAMES, type DecisionsPort } from './decision-tools'
import { KernelError } from './errors'
import { InMemoryEventSink } from './events'
import { coworkerPrincipal, delegatedPrincipal } from './principals'
import { KernelRegistry } from './registry'

const admin: ToolContext = { principal: { id: 'u-admin', kind: 'human', roles: ['admin', 'member'] }, requestId: 'r1' }
const member: ToolContext = { principal: { id: 'u-mia', kind: 'human', roles: ['member'] }, requestId: 'r2' }
const brainAsMia: ToolContext = { principal: delegatedPrincipal({ id: 'u-mia', roles: ['member'] }, 'orchestrator'), requestId: 'r3' }
const coworker: ToolContext = { principal: coworkerPrincipal('cw-1', 'coworker-cw-1'), requestId: 'r4' }

const QUESTION = '3e9b6f4b-bc88-4f5d-a03b-9d4e5f607182'

function setup() {
  const port: DecisionsPort = {
    kinds: vi.fn(async () => []),
    log: vi.fn(async () => []),
    questions: vi.fn(async () => []),
    answer: vi.fn(async (_userId: string, decisionId: string, choice: string) => ({ decisionId, kind: 'demo.k', choice })),
    label: vi.fn(async (_userId: string, decisionId: string, choice: string) => ({ decisionId, kind: 'demo.k', choice })),
  }
  const registry = new KernelRegistry({
    eventSink: new InMemoryEventSink(),
    approvalPolicy: new ModeAwareApprovalPolicy(new Set(), new InMemoryApprovalModeStore('ask')),
    approvalStore: new InMemoryApprovalStore(),
  })
  for (const tool of createDecisionTools({ port })) registry.register(tool)
  return { registry, port }
}

describe('decisions.* tools', () => {
  it('are the kinds, the log, your questions, your answer and an admin’s label', () => {
    const { port } = setup()
    expect(createDecisionTools({ port }).map((t) => t.name)).toEqual([...KERNEL_DECISION_TOOL_NAMES])
    expect(KERNEL_DECISION_TOOL_NAMES).toEqual(['decisions.kinds', 'decisions.log', 'decisions.questions', 'decisions.answer', 'decisions.label'])
  })

  it('every member reads the kinds (aggregates only)', async () => {
    const { registry } = setup()
    await expect(registry.execute('decisions.kinds', {}, member)).resolves.toEqual({ kinds: [] })
  })

  it('the log: owner and admins read every row; a member (also through the brain) and a co-worker only their own', async () => {
    const { registry, port } = setup()
    await registry.execute('decisions.log', { kind: 'website.page_audience' }, admin)
    expect(port.log).toHaveBeenLastCalledWith({ kind: 'website.page_audience', limit: 50, readerId: null })
    await registry.execute('decisions.log', {}, member)
    expect(port.log).toHaveBeenLastCalledWith({ limit: 50, readerId: 'u-mia' })
    await registry.execute('decisions.log', { limit: 5 }, brainAsMia)
    expect(port.log).toHaveBeenLastCalledWith({ limit: 5, readerId: 'u-mia' })
    await registry.execute('decisions.log', {}, coworker)
    expect(port.log).toHaveBeenLastCalledWith({ limit: 50, readerId: 'cw-1' })
  })

  it('the log narrows to the decisions about one person or co-worker (C7: a co-worker’s "Would pick up")', async () => {
    const { registry, port } = setup()
    await registry.execute('decisions.log', { kind: 'coworkers.event_mine', subject_user_id: 'cw-1', limit: 20 }, admin)
    expect(port.log).toHaveBeenLastCalledWith({ kind: 'coworkers.event_mine', subjectUserId: 'cw-1', limit: 20, readerId: null })
  })

  it('owner and admins label a decision as themselves; members and co-workers cannot', async () => {
    const { registry, port } = setup()
    await expect(registry.execute('decisions.label', { decision_id: QUESTION, choice: 'no' }, admin)).resolves.toEqual({ decisionId: QUESTION, kind: 'demo.k', choice: 'no' })
    expect(port.label).toHaveBeenLastCalledWith('u-admin', QUESTION, 'no')
    await expect(registry.execute('decisions.label', { decision_id: QUESTION, choice: 'no' }, member)).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(registry.execute('decisions.label', { decision_id: QUESTION, choice: 'no' }, coworker)).rejects.toMatchObject({ code: 'permission_denied' })
    const agent: ToolContext = { principal: { id: 'agent-1', kind: 'agent', roles: ['admin'] }, requestId: 'r5' }
    await expect(registry.execute('decisions.label', { decision_id: QUESTION, choice: 'no' }, agent)).rejects.toMatchObject({ code: 'no_person' })
    expect(port.label).toHaveBeenCalledTimes(1)
  })

  it('questions are the caller’s own', async () => {
    const { registry, port } = setup()
    await registry.execute('decisions.questions', {}, member)
    expect(port.questions).toHaveBeenCalledWith('u-mia')
  })

  it('a person answers their question (themselves or through the brain), never needing an approval', async () => {
    const { registry, port } = setup()
    await expect(registry.execute('decisions.answer', { decision_id: QUESTION, choice: 'yes' }, member)).resolves.toEqual({
      decisionId: QUESTION,
      kind: 'demo.k',
      choice: 'yes',
    })
    await registry.execute('decisions.answer', { decision_id: QUESTION, choice: 'no' }, brainAsMia)
    expect(port.answer).toHaveBeenLastCalledWith('u-mia', QUESTION, 'no')
  })

  it('a co-worker cannot answer a question asked of a person', async () => {
    const { registry, port } = setup()
    const err = await registry.execute('decisions.answer', { decision_id: QUESTION, choice: 'yes' }, coworker).catch((e) => e)
    expect(err).toBeInstanceOf(KernelError)
    expect(err.code).toBe('no_person')
    expect(port.answer).not.toHaveBeenCalled()
  })

  it('refuses a malformed answer before the port', async () => {
    const { registry, port } = setup()
    await expect(registry.execute('decisions.answer', { decision_id: 'nope', choice: 'yes' }, member)).rejects.toMatchObject({
      code: 'invalid_input',
    })
    expect(port.answer).not.toHaveBeenCalled()
  })
})
