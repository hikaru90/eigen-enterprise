import { describe, expect, it, vi } from 'vitest'
import { POST } from './+server'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import { KernelRegistry } from '$lib/kernel/registry'
import { createMemoryTools } from '../../../../modules/memory/tools'

// The kernel contract (wt/wire): the HTTP MCP surface renders from the kernel
// registry and gates calls on module activation. The fixture kernel activates
// `memory` so the dispatch test exercises the real pipeline (permission →
// validation → handler) with the tool implementations mocked below. The old
// unprefixed tool name (`retrieve_thoughts`) is gone — tools are namespaced.
const activations = new InMemoryActivationStore()
await activations.set('memory', true)
const fixtureKernel = {
  registry: new KernelRegistry({
    eventSink: new InMemoryEventSink(),
    activationStore: activations,
  }),
  activations,
}
for (const tool of createMemoryTools()) fixtureKernel.registry.register(tool)

vi.mock('../../../../modules/index', () => ({
  bootstrapKernel: () => fixtureKernel,
}))

const {
  runCaptureThoughtToolMock,
  runRetrieveThoughtsToolMock,
  runEditThoughtToolMock,
  runDeleteThoughtToolMock,
} = vi.hoisted(() => ({
  runCaptureThoughtToolMock: vi.fn(),
  runRetrieveThoughtsToolMock: vi.fn(),
  runEditThoughtToolMock: vi.fn(),
  runDeleteThoughtToolMock: vi.fn(),
}))

vi.mock('$lib/server/mcp/tools', () => ({
  runCaptureThoughtTool: runCaptureThoughtToolMock,
  runAnswerQuestionTool: vi.fn(),
  runRetrieveThoughtsTool: runRetrieveThoughtsToolMock,
  runEditThoughtTool: runEditThoughtToolMock,
  runDeleteThoughtTool: runDeleteThoughtToolMock,
  runListProjectsTool: vi.fn(),
  runGetProjectTimelineTool: vi.fn(),
  runOrderTaskInProjectTool: vi.fn(),
  runSetProjectMilestoneTool: vi.fn(),
  runSetProjectDeadlineTool: vi.fn(),
  runGenerateProjectPlanTool: vi.fn(),
  runCreateProjectTool: vi.fn(),
  runEditProjectTool: vi.fn(),
  runDeleteProjectTool: vi.fn(),
  runCreateTextFileTool: vi.fn(),
  runListTextFilesTool: vi.fn(),
  runGetTextFileTool: vi.fn(),
  runUpdateTextFileTool: vi.fn(),
  runAppendTextFileTool: vi.fn(),
  runDeleteTextFileTool: vi.fn(),
  runSearchTextFilesTool: vi.fn(),
  runLinkTextFileToThoughtTool: vi.fn(),
  runUnlinkTextFileFromThoughtTool: vi.fn(),
}))

function makeRequest(body: unknown, method = 'POST'): Request {
  return new Request('http://localhost/api/mcp', {
    method,
    headers: {
      'Content-Type': 'application/json',
      // MCP transport requires both types in Accept header (line 378 of webStandardStreamableHttp.js)
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  })
}

describe('POST /api/mcp', () => {
  it('requires auth', async () => {
    const res = await POST({
      locals: { user: null },
      request: makeRequest({}),
    } as never)
    expect(res.status).toBe(401)
  })

  it('lists tools', async () => {
    const res = await POST({
      locals: { user: { id: 'u1' } },
      request: makeRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    } as never)
    expect(res.status).toBe(200)
  })

  it('rejects unknown tool name', async () => {
    const res = await POST({
      locals: { user: { id: 'u1' } },
      request: makeRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'nope', arguments: {} },
      }),
    } as never)
    // MCP SDK returns error in JSON-RPC body with 200, or 4xx — either is acceptable
    expect(res.status).toBeGreaterThanOrEqual(200)
    if (res.status === 200) {
      const body = (await res.json()) as { error?: unknown }
      expect(body.error).toBeDefined()
    }
  })

  it('dispatches tool call', async () => {
    runRetrieveThoughtsToolMock.mockResolvedValue({ results: [{ id: 't1' }] })
    const res = await POST({
      locals: { user: { id: 'u1' } },
      request: makeRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'memory.retrieve_thoughts', arguments: { query: 'hello' } },
      }),
    } as never)
    expect(runRetrieveThoughtsToolMock).toHaveBeenCalledWith({ userId: 'u1' }, { query: 'hello' })
    expect(res.status).toBe(200)
  })
})
