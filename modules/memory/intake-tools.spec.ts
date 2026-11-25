import { describe, expect, it, vi } from 'vitest'
import { KernelError } from '$lib/kernel/errors'
import type { ToolContext } from '$lib/kernel/types'
import type { BrainIntake } from '$lib/memory/brain-intake'
import { createIntakeTools } from './intake-tools'
import { INTAKE_TOOL_NAMES, memoryManifest } from './manifest'

const INTAKE: BrainIntake = {
  asOf: '2026-11-25T12:00:00.000Z',
  totals: { day: 1, week: 2, month: 3, all: 4 },
  bySource: [{ source: { kind: 'assistant' }, counts: { day: 1, week: 2, month: 3, all: 4 } }],
  recent: [],
}

function setup(
  writer:
    | { kind: 'self' | 'assistant'; userId: string }
    | { kind: 'coworker'; userId: string; name: string }
    | null,
) {
  const load = vi.fn(async () => INTAKE)
  const tools = createIntakeTools({ load, writerOf: async () => writer })
  const ctx: ToolContext = {
    principal: { id: 'p', kind: 'human', roles: ['member'] },
    requestId: 'r',
  }
  const run = (input: unknown = {}) => tools[0]!.handler(ctx, input)
  return { tools, load, run }
}

describe('memory.intake (what the brain took in, as the caller may see it)', () => {
  it('is one read tool in the memory module, listed in the manifest', () => {
    const { tools } = setup({ kind: 'self', userId: 'ony' })
    expect(tools.map((t) => t.name)).toEqual([...INTAKE_TOOL_NAMES])
    expect(tools[0]).toMatchObject({ name: 'memory.intake', module: 'memory', auditClass: 'read' })
    expect(tools[0]!.activity).toBeUndefined()
    expect(memoryManifest.tools).toContain('memory.intake')
  })

  it('reads as the person: their own, or the person the assistant answers — never anyone else', async () => {
    const self = setup({ kind: 'self', userId: 'ony' })
    await expect(self.run({})).resolves.toEqual(INTAKE)
    expect(self.load).toHaveBeenCalledWith('ony', 30)

    const brain = setup({ kind: 'assistant', userId: 'ben' })
    await brain.run({ limit: 5 })
    expect(brain.load).toHaveBeenCalledWith('ben', 5)

    const coworker = setup({ kind: 'coworker', userId: 'cw-1', name: 'Scout' })
    await coworker.run({})
    expect(coworker.load).toHaveBeenCalledWith('cw-1', 30)
  })

  it('an agent run that works for no one reads nothing', async () => {
    const nobody = setup(null)
    await expect(nobody.run({})).rejects.toBeInstanceOf(KernelError)
    expect(nobody.load).not.toHaveBeenCalled()
  })

  it('refuses a limit out of range and unknown fields (no user id to read someone else)', async () => {
    const { run, load } = setup({ kind: 'self', userId: 'ony' })
    await expect(run({ limit: 0 })).rejects.toThrow()
    await expect(run({ limit: 101 })).rejects.toThrow()
    await expect(run({ user_id: 'ben' })).rejects.toThrow()
    expect(load).not.toHaveBeenCalled()
  })
})
