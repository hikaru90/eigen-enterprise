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
}))

import type { ToolContext } from '$lib/kernel/types'
import { MEMORY_TOOL_NAMES, memoryManifest } from './manifest'
import { createMemoryTools } from './tools'

const ctx: ToolContext = {
  principal: { id: 'principal-1', kind: 'human', roles: ['admin', 'agent'] },
  requestId: 'req-1',
}

describe('memoryManifest', () => {
  it('owns the namespaced memory tool names', () => {
    expect(memoryManifest.id).toBe('memory')
    expect(memoryManifest.tools).toEqual([...MEMORY_TOOL_NAMES])
    expect(memoryManifest.tools.every((name) => name.startsWith('memory.'))).toBe(true)
  })
})

describe('createMemoryTools', () => {
  const tools = createMemoryTools()

  it('builds one descriptor per manifest tool name', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([...MEMORY_TOOL_NAMES].sort())
    for (const descriptor of tools) {
      expect(descriptor.module).toBe('memory')
      expect(descriptor.permission.roles).toEqual(['admin', 'agent'])
      expect(descriptor.summary.length).toBeGreaterThan(0)
    }
  })

  it('marks capture and note writes as mutate and the rest as read', () => {
    const byName = new Map(tools.map((t) => [t.name, t]))
    const writes = ['memory.capture_thought', 'memory.create_text_file', 'memory.update_text_file']
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
