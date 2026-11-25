import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const runMock = vi.fn(async () => ({ ok: true }))

vi.mock('$lib/server/mcp/tools', () => ({
  runCaptureThoughtTool: runMock,
  runRetrieveThoughtsTool: runMock,
  runListProjectsTool: runMock,
  runGetProjectTimelineTool: runMock,
  runListTextFilesTool: runMock,
  runGetTextFileTool: runMock,
  runSearchTextFilesTool: runMock,
  runCreateTextFileTool: runMock,
  runUpdateTextFileTool: runMock,
  runSetProjectVisibilityTool: runMock,
  runSetTextFileVisibilityTool: runMock,
}))

import type { ToolContext } from '$lib/kernel/types'
import { MEMORY_TOOL_NAMES, memoryManifest, OWN_TASK_TOOL_NAMES, PROJECT_SCHEDULE_TOOL_NAMES, QUESTION_TOOL_NAMES, REMINDER_TOOL_NAMES, TASK_TOOL_NAMES, THOUGHT_TOOL_NAMES } from './manifest'
import { createMemoryTools } from './tools'

const ctx: ToolContext = {
  principal: { id: 'principal-1', kind: 'human', roles: ['admin', 'agent'] },
  requestId: 'req-1',
}

describe('memoryManifest', () => {
  it('owns the namespaced memory tool names', () => {
    expect(memoryManifest.id).toBe('memory')
    expect(memoryManifest.tools).toEqual([...MEMORY_TOOL_NAMES, ...THOUGHT_TOOL_NAMES, ...OWN_TASK_TOOL_NAMES, ...TASK_TOOL_NAMES, ...REMINDER_TOOL_NAMES, ...QUESTION_TOOL_NAMES, ...PROJECT_SCHEDULE_TOOL_NAMES])
    expect([...MEMORY_TOOL_NAMES, ...OWN_TASK_TOOL_NAMES].every((name) => name.startsWith('memory.'))).toBe(true)
    expect(TASK_TOOL_NAMES.every((name) => name.startsWith('tasks.'))).toBe(true)
    expect(REMINDER_TOOL_NAMES.every((name) => name.startsWith('reminders.'))).toBe(true)
    expect(QUESTION_TOOL_NAMES.every((name) => name.startsWith('questions.'))).toBe(true)
  })
})

describe('createMemoryTools', () => {
  const ownTasks = new Set<string>([...OWN_TASK_TOOL_NAMES, ...THOUGHT_TOOL_NAMES, ...PROJECT_SCHEDULE_TOOL_NAMES])
  // The own-task, thought and project/schedule tools are pinned in their own specs.
  const tools = createMemoryTools().filter((t) => t.name.startsWith('memory.') && !ownTasks.has(t.name))

  it('builds one descriptor per manifest tool name', () => {
    expect(createMemoryTools().map((t) => t.name).sort()).toEqual([...memoryManifest.tools].sort())
    expect(tools.map((t) => t.name).sort()).toEqual([...MEMORY_TOOL_NAMES].sort())
    for (const descriptor of tools) {
      expect(descriptor.module).toBe('memory')
      // Every member's own Memory (CB3: the brain reaches it as the member).
      expect(descriptor.permission.roles).toEqual(['admin', 'member', 'agent'])
      expect(descriptor.summary.length).toBeGreaterThan(0)
    }
  })

  it('marks capture and note writes as mutate and the rest as read', () => {
    const byName = new Map(tools.map((t) => [t.name, t]))
    const writes = [
      'memory.capture_thought',
      'memory.create_text_file',
      'memory.update_text_file',
      'memory.set_project_visibility',
      'memory.set_text_file_visibility',
    ]
    for (const name of writes) expect(byName.get(name)?.auditClass).toBe('mutate')
    for (const name of [...MEMORY_TOOL_NAMES].filter((n) => !writes.includes(n))) {
      expect(byName.get(name)?.auditClass).toBe('read')
    }
  })

  it('a write lands with the person the writer resolves to, not the principal id', async () => {
    runMock.mockClear()
    const asSelf = createMemoryTools({
      writerOf: async () => ({ kind: 'self', userId: 'person-1' }),
    })
    const create = asSelf.find((t) => t.name === 'memory.create_text_file')!
    await create.handler(ctx, { title: 'Hello' })
    expect(runMock).toHaveBeenCalledWith({ userId: 'person-1' }, { title: 'Hello' })
  })

  it('a write by an agent working for no one fails loud before touching Memory', async () => {
    runMock.mockClear()
    const forNoOne = createMemoryTools({ writerOf: async () => null })
    for (const name of [
      'memory.capture_thought',
      'memory.create_text_file',
      'memory.update_text_file',
    ]) {
      const descriptor = forNoOne.find((t) => t.name === name)!
      await expect(
        descriptor.handler(ctx, { raw: 'x', text_file_id: 'f', title: 't' }),
      ).rejects.toMatchObject({
        code: 'permission_denied',
        message: expect.stringMatching(/works for no one/i),
      })
    }
    expect(runMock).not.toHaveBeenCalled()
  })

  it('the assistant may make a project or note private for the person, never share it', async () => {
    runMock.mockClear()
    const asAssistant = createMemoryTools({
      writerOf: async () => ({ kind: 'assistant', userId: 'person-1' }),
    })
    for (const [name, idKey] of [
      ['memory.set_project_visibility', 'project_entity_id'],
      ['memory.set_text_file_visibility', 'text_file_id'],
    ] as const) {
      const descriptor = asAssistant.find((t) => t.name === name)!
      await expect(descriptor.handler(ctx, { [idKey]: 'x', private: false })).rejects.toMatchObject({
        code: 'permission_denied',
        message: expect.stringMatching(/never share/i),
      })
      await descriptor.handler(ctx, { [idKey]: 'x', private: true })
      expect(runMock).toHaveBeenLastCalledWith({ userId: 'person-1' }, { [idKey]: 'x', private: true })
    }
  })

  it('a write to a colleague’s shared item is a permission error naming its owner', async () => {
    const { MemoryReadOnlyError } = await import('$lib/server/memory/memory-read-only')
    runMock.mockRejectedValueOnce(new MemoryReadOnlyError('note', 'Ana'))
    const descriptor = createMemoryTools({ writerOf: async () => ({ kind: 'self', userId: 'person-1' }) }).find(
      (t) => t.name === 'memory.update_text_file',
    )!
    await expect(descriptor.handler(ctx, { text_file_id: 'f', body: 'x' })).rejects.toMatchObject({
      code: 'permission_denied',
      message: expect.stringMatching(/Ana’s: it is read-only/),
    })
  })

  it('validates required inputs with zod', () => {
    const byName = new Map(tools.map((t) => [t.name, t]))
    expect(byName.get('memory.capture_thought')?.inputSchema.safeParse({}).success).toBe(false)
    expect(
      byName.get('memory.capture_thought')?.inputSchema.safeParse({ raw: 'remember this' }).success,
    ).toBe(true)
    expect(
      byName.get('memory.get_project_timeline')?.inputSchema.safeParse({
        project_entity_id: 'e1',
      }).success,
    ).toBe(true)
    expect(byName.get('memory.retrieve_thoughts')?.inputSchema instanceof z.ZodType).toBe(true)
  })

  it('maps ctx.principal.id to the underlying userId (retrieve_thoughts)', async () => {
    runMock.mockClear()
    const descriptor = tools.find((t) => t.name === 'memory.retrieve_thoughts')
    if (!descriptor) throw new Error('memory.retrieve_thoughts descriptor missing')

    await expect(descriptor.handler(ctx, { query: 'hello' })).resolves.toEqual({ ok: true })
    expect(runMock).toHaveBeenCalledWith({ userId: 'principal-1' }, { query: 'hello' })
  })
})

describe('an AI co-worker in Memory (plan/phase-ai-coworkers.md §7)', () => {
  const cwCtx: ToolContext = {
    principal: { id: 'cw-1', kind: 'coworker', roles: ['member'], agentId: 'coworker-cw-1' },
    requestId: 'req-cw',
  }
  const asCoworker = createMemoryTools({ writerOf: async () => ({ kind: 'coworker', userId: 'cw-1', name: 'Mara' }) })
  const byName = new Map(asCoworker.map((t) => [t.name, t]))
  const call = (name: string, input: unknown) => byName.get(name)!.handler(cwCtx, input)

  it('reads and writes as itself, with its name, in its own Memory', async () => {
    runMock.mockClear()
    await call('memory.capture_thought', { raw: 'Campaign idea' })
    expect(runMock).toHaveBeenCalledWith({ userId: 'cw-1', coworker: { name: 'Mara' } }, { raw: 'Campaign idea' })
    await call('memory.retrieve_thoughts', { query: 'campaign' })
    expect(runMock).toHaveBeenLastCalledWith({ userId: 'cw-1', coworker: { name: 'Mara' } }, { query: 'campaign' })
    await call('memory.create_text_file', { title: 'Plan' })
    expect(runMock).toHaveBeenLastCalledWith({ userId: 'cw-1', coworker: { name: 'Mara' } }, { title: 'Plan' })
  })

  it('a person’s own clicks stay theirs: sharing, check-ins, connected agents and reminders refuse it', async () => {
    for (const [name, input] of [
      ['memory.set_project_visibility', { project_entity_id: 'p1', private: true }],
      ['memory.set_text_file_visibility', { text_file_id: 'n1', private: false }],
      ['memory.answer_check_in', { kind: 'dismiss' }],
      ['memory.list_connected_agents', {}],
      ['memory.assign_thought_to_agent', { agent_id: 'a1', thought_id: 't1' }],
      ['reminders.create', { title: 'x' }],
      ['reminders.list', {}],
    ] as const) {
      await expect(call(name, input)).rejects.toMatchObject({ code: 'permission_denied' })
    }
  })

  it('works in the open under its own name: no private notes or projects, no author or as_user', async () => {
    runMock.mockClear()
    await expect(call('memory.create_text_file', { title: 'Hidden', private: true })).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(call('memory.create_project', { label: 'Hidden', private: true })).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(call('memory.capture_thought', { raw: 'x', as_user: true })).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(call('memory.capture_thought', { raw: 'x', author: 'ee_abc' })).rejects.toMatchObject({ code: 'permission_denied' })
    expect(runMock).not.toHaveBeenCalled()
  })

  it('the refusals are for co-workers only: a person still shares their own note', async () => {
    runMock.mockClear()
    const asPerson = createMemoryTools({ writerOf: async () => ({ kind: 'self', userId: 'person-1' }) })
    await asPerson.find((t) => t.name === 'memory.set_text_file_visibility')!.handler(ctx, { text_file_id: 'n1', private: false })
    expect(runMock).toHaveBeenCalledWith({ userId: 'person-1' }, { text_file_id: 'n1', private: false })
  })

  it('a co-worker principal never runs as a person or the assistant', async () => {
    const confused = createMemoryTools({ writerOf: async () => ({ kind: 'self', userId: 'cw-1' }) })
    await expect(confused.find((t) => t.name === 'memory.retrieve_thoughts')!.handler(cwCtx, { query: 'x' })).rejects.toThrow(
      /co-worker principal resolved to a self writer/,
    )
  })
})
