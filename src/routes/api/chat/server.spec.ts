import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmNotConfiguredError } from '$lib/server/llm/errors'

const { bootAppMock, runtimeDispatchMock, getDbMock, appSqlMock, createScopedDrizzleMock } =
  vi.hoisted(() => ({
    bootAppMock: vi.fn(),
    runtimeDispatchMock: vi.fn(),
    getDbMock: vi.fn(),
    appSqlMock: {
      reserve: vi.fn(),
    },
    createScopedDrizzleMock: vi.fn(),
  }))

vi.mock('$lib/server/boot', () => ({ bootApp: bootAppMock }))
vi.mock('$lib/server/db', () => ({
  getDb: getDbMock,
  appSql: appSqlMock,
  appDbAsyncLocal: { run: (_db: unknown, fn: () => unknown) => fn() },
  createScopedDrizzle: createScopedDrizzleMock,
  activateTenantDbSession: vi.fn(async () => undefined),
  deactivateTenantDbSession: vi.fn(async () => undefined),
}))
vi.mock('$lib/server/activity/trace-context', () => ({
  runWithTrace: (_id: string, fn: () => unknown) => fn(),
}))

const SESSION_ID = 'sess-1'
const ASSISTANT_MSG_ID = 'asst-1'

function chatRequest(body: unknown, opts?: { ndjson?: boolean; signal?: AbortSignal }) {
  return {
    json: vi.fn(async () => body),
    headers: {
      get: (name: string) =>
        opts?.ndjson !== false && name.toLowerCase() === 'accept' ? 'application/x-ndjson' : null,
    },
    signal: opts?.signal ?? new AbortController().signal,
  }
}

function ndjsonRequest(body: unknown, signal?: AbortSignal) {
  return chatRequest(body, { ndjson: true, signal })
}

function jsonRequest(body: unknown) {
  return chatRequest(body, { ndjson: false })
}

/** Drizzle where-clause mock: supports .limit(), .orderBy(), and bare await. */
function thenableWhere(rows: unknown[]) {
  return {
    limit: vi.fn().mockResolvedValue(rows),
    orderBy: vi.fn().mockResolvedValue(rows),
    then(onFulfilled?: (value: unknown) => unknown, onRejected?: (error: unknown) => unknown) {
      return Promise.resolve(rows).then(onFulfilled, onRejected)
    },
  }
}

function buildMainDb() {
  const insertValues = vi
    .fn()
    .mockReturnValueOnce({
      returning: vi.fn().mockResolvedValue([{ id: SESSION_ID, mode: 'default' }]),
    })
    .mockReturnValueOnce({})
    .mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: ASSISTANT_MSG_ID }]),
    })
  const insert = vi.fn().mockReturnValue({ values: insertValues })

  const whereForSelect = vi.fn().mockImplementation(() => thenableWhere([{ count: 1 }]))
  const select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: whereForSelect,
    }),
  })

  const update = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  })

  whereForSelect.mockImplementationOnce(() => thenableWhere([{ id: SESSION_ID, mode: 'default' }]))
  whereForSelect.mockImplementationOnce(() => thenableWhere([]))
  whereForSelect.mockImplementation(() => thenableWhere([{ count: 1 }]))

  return { insert, select, update }
}

function buildStreamDb() {
  return {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: ASSISTANT_MSG_ID }]),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  }
}

async function readNdjsonLines(res: Response) {
  const text = await res.text()
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; [key: string]: unknown })
}

describe('POST /api/chat — harness dispatch', () => {
  beforeEach(() => {
    runtimeDispatchMock.mockReset()
    bootAppMock.mockReset()
    getDbMock.mockReset()
    appSqlMock.reserve.mockReset()
    createScopedDrizzleMock.mockReset()
    bootAppMock.mockResolvedValue({
      orchestrator: { runtime: { dispatch: runtimeDispatchMock } },
    })
    getDbMock.mockReturnValue(buildMainDb())
    const streamDb = buildStreamDb()
    createScopedDrizzleMock.mockReturnValue(streamDb)
    appSqlMock.reserve.mockResolvedValue(
      Object.assign(vi.fn().mockResolvedValue(undefined), {
        release: vi.fn().mockResolvedValue(undefined),
      }),
    )
  })

  it('rejects bootstrap without briefingPeriod', async () => {
    const { POST } = await import('./+server')
    await expect(
      POST({
        locals: { user: { id: 'u1' } },
        request: ndjsonRequest({ bootstrap: true }),
      } as never),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('requires auth', async () => {
    const { POST } = await import('./+server')
    await expect(
      POST({ locals: { user: null }, request: ndjsonRequest({ message: 'hi' }) } as never),
    ).rejects.toMatchObject({ status: 401 })
  })

  it('rejects empty message', async () => {
    const { POST } = await import('./+server')
    await expect(
      POST({
        locals: { user: { id: 'u1' } },
        request: ndjsonRequest({ message: '   ' }),
      } as never),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('rejects invalid JSON body', async () => {
    const { POST } = await import('./+server')
    await expect(
      POST({
        locals: { user: { id: 'u1' } },
        request: {
          json: vi.fn(async () => {
            throw new SyntaxError('invalid json')
          }),
          headers: { get: () => null },
          signal: new AbortController().signal,
        },
      } as never),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('returns 404 when sessionId does not exist', async () => {
    const { POST } = await import('./+server')
    const whereForSelect = vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue([]),
    })
    getDbMock.mockReturnValue({
      insert: vi.fn(),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: whereForSelect }),
      }),
      update: vi.fn(),
    })

    await expect(
      POST({
        locals: { user: { id: 'u1' } },
        request: ndjsonRequest({ message: 'hello', sessionId: 'missing-session' }),
      } as never),
    ).rejects.toMatchObject({ status: 404 })
  })

  it('dispatches through the kernel runtime as the orchestrator agent with the session and sinks', async () => {
    const { POST } = await import('./+server')
    runtimeDispatchMock.mockResolvedValue('Runtime reply.')

    const res = await POST({
      locals: { user: { id: 'u1' } },
      request: ndjsonRequest({ message: 'hello' }),
    } as never)

    await res.text()
    expect(bootAppMock).toHaveBeenCalledTimes(1)
    expect(runtimeDispatchMock).toHaveBeenCalledTimes(1)
    const [agentId, dispatchSessionId, message, sinks] = runtimeDispatchMock.mock.calls[0]
    expect(agentId).toBe('orchestrator')
    expect(dispatchSessionId).toBe(SESSION_ID)
    expect(message).toBe('hello')
    expect(typeof sinks.stream).toBe('function')
    expect(typeof sinks.surfaceEvent).toBe('function')
  })

  it('streams harness events (tool.preview, message_delta) and persists the turn', async () => {
    const { POST } = await import('./+server')
    runtimeDispatchMock.mockImplementation(
      async (
        _agentId: string,
        _sessionId: string,
        _message: string,
        sinks: {
          stream: (delta: string) => void
          surfaceEvent: (event: unknown) => void
        },
      ) => {
        sinks.surfaceEvent({
          type: 'tool.preview',
          tool: 'email.send_mail',
          inputSummary: '{"to":"a@b.c"}',
        })
        sinks.stream('Hello ')
        sinks.stream('there.')
        return 'Hello there.'
      },
    )
    const streamDb = buildStreamDb()
    const insertMock = streamDb.insert as ReturnType<typeof vi.fn>
    createScopedDrizzleMock.mockReturnValue(streamDb)

    const res = await POST({
      locals: { user: { id: 'u1' } },
      request: ndjsonRequest({ message: 'email alex' }),
    } as never)

    expect(res.headers.get('content-type')).toContain('ndjson')
    const lines = await readNdjsonLines(res)
    expect(lines).toContainEqual({
      type: 'tool.preview',
      tool: 'email.send_mail',
      inputSummary: '{"to":"a@b.c"}',
    })
    expect(lines).toContainEqual({ type: 'message_delta', content: 'Hello ' })
    expect(lines).toContainEqual({ type: 'message_delta', content: 'there.' })
    const last = lines[lines.length - 1]
    expect(last.type).toBe('done')
    expect(last.response).toBe('Hello there.')
    expect(last.sessionId).toBe(SESSION_ID)
    // Preview step + final assistant message persisted.
    expect(insertMock.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('passes approval.required through as a stream event', async () => {
    const { POST } = await import('./+server')
    runtimeDispatchMock.mockImplementation(
      async (
        _agentId: string,
        _sessionId: string,
        _message: string,
        sinks: { surfaceEvent: (e: unknown) => void },
      ) => {
        sinks.surfaceEvent({ type: 'approval.required', tool: 'email.send_mail' })
        return 'Queued for owner approval.'
      },
    )

    const res = await POST({
      locals: { user: { id: 'u1' } },
      request: ndjsonRequest({ message: 'send it' }),
    } as never)

    const lines = await readNdjsonLines(res)
    expect(lines).toContainEqual({ type: 'approval.required', tool: 'email.send_mail' })
    const last = lines[lines.length - 1]
    expect(last.type).toBe('done')
    expect(last.response).toBe('Queued for owner approval.')
  })

  it('returns JSON response on non-ndjson success', async () => {
    const { POST } = await import('./+server')
    runtimeDispatchMock.mockResolvedValue('Plain JSON reply.')

    const res = await POST({
      locals: { user: { id: 'u1' } },
      request: jsonRequest({ message: 'hello' }),
    } as never)

    expect(res.headers.get('content-type')).not.toContain('ndjson')
    expect(await res.json()).toMatchObject({
      response: 'Plain JSON reply.',
      sessionId: SESSION_ID,
      messageId: ASSISTANT_MSG_ID,
    })
  })

  it('returns 500 JSON when dispatch throws on non-ndjson path', async () => {
    const { POST } = await import('./+server')
    runtimeDispatchMock.mockRejectedValue(new Error('gateway timeout'))
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const res = await POST({
      locals: { user: { id: 'u1' } },
      request: jsonRequest({ message: 'hello' }),
    } as never)

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({
      response: 'An unexpected error occurred.',
      sessionId: SESSION_ID,
      history: [],
    })
    consoleSpy.mockRestore()
  })

  it('streams ndjson error line when dispatch throws', async () => {
    const { POST } = await import('./+server')
    runtimeDispatchMock.mockRejectedValue(new Error('embedding failed'))
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const res = await POST({
      locals: { user: { id: 'u1' } },
      request: ndjsonRequest({ message: 'hello' }),
    } as never)

    const lines = await readNdjsonLines(res)
    const last = lines[lines.length - 1]
    expect(last.type).toBe('error')
    expect(last.error).toBe('embedding failed')
    consoleSpy.mockRestore()
  })

  it('tags llm_not_configured failures through the dispatch path', async () => {
    const { POST } = await import('./+server')
    runtimeDispatchMock.mockRejectedValue(
      new Error('agent loop failed', {
        cause: new LlmNotConfiguredError('LLM not configured: set LLM_BASE_URL'),
      }),
    )
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const res = await POST({
      locals: { user: { id: 'u1' } },
      request: ndjsonRequest({ message: 'hello' }),
    } as never)

    const lines = await readNdjsonLines(res)
    const last = lines[lines.length - 1]
    expect(last.type).toBe('error')
    expect(last.code).toBe('llm_not_configured')
    consoleSpy.mockRestore()
  })

  it('always ends stream with done or error terminal event', async () => {
    const { POST } = await import('./+server')
    runtimeDispatchMock.mockResolvedValue('ok')
    const res = await POST({
      locals: { user: { id: 'u1' } },
      request: ndjsonRequest({ message: 'hello' }),
    } as never)
    const lines = await readNdjsonLines(res)
    const terminal = lines.filter((l) => l.type === 'done' || l.type === 'error')
    expect(terminal).toHaveLength(1)
  })

  function delayedDispatchMock() {
    runtimeDispatchMock.mockImplementation(
      async (
        _agentId: string,
        _sessionId: string,
        _message: string,
        sinks: { stream: (delta: string) => void },
      ) => {
        sinks.stream('partial')
        await new Promise((r) => setTimeout(r, 50))
        sinks.stream(' reply')
        return 'partial reply'
      },
    )
  }

  function enqueueFailedCalls(spy: ReturnType<typeof vi.spyOn>) {
    return spy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('[api/chat] stream enqueue failed'),
    )
  }

  it('does not log enqueue errors when consumer cancels mid-stream', async () => {
    const { POST } = await import('./+server')
    delayedDispatchMock()
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const res = await POST({
      locals: { user: { id: 'u1' } },
      request: ndjsonRequest({ message: 'hello' }),
    } as never)

    const reader = res.body?.getReader()
    expect(reader).toBeDefined()
    await reader!.read()
    await reader!.cancel()
    await new Promise((r) => setTimeout(r, 120))

    expect(enqueueFailedCalls(consoleSpy)).toHaveLength(0)
    consoleSpy.mockRestore()
  })

  it('does not log enqueue errors when request aborts mid-stream', async () => {
    const { POST } = await import('./+server')
    delayedDispatchMock()
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const ac = new AbortController()

    const res = await POST({
      locals: { user: { id: 'u1' } },
      request: ndjsonRequest({ message: 'hello' }, ac.signal),
    } as never)

    const reader = res.body?.getReader()
    expect(reader).toBeDefined()
    await reader!.read()
    ac.abort()
    await new Promise((r) => setTimeout(r, 120))

    expect(enqueueFailedCalls(consoleSpy)).toHaveLength(0)
    consoleSpy.mockRestore()
  })
})
