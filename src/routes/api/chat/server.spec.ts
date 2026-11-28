import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryJourneyStore, initialJourneyState } from '$lib/kernel/playbook'
import { KernelRegistry } from '$lib/kernel/registry'
import { CHAT_TURN_FAILED_MESSAGE } from '$lib/server/chat/handle-agent-chat-post'
import { LlmNotConfiguredError } from '$lib/server/llm/errors'
import {
  JourneyAwareAgentRuntime,
  WEBSITE_FOUNDING_JOURNEY,
  orchestratorAgentConfig,
} from '../../../../modules/orchestrator/brain'

const { bootAppMock, runtimeDispatchMock, handoffDispatchMock, getDbMock, appSqlMock, createScopedDrizzleMock } =
  vi.hoisted(() => ({
    bootAppMock: vi.fn(),
    runtimeDispatchMock: vi.fn(),
    handoffDispatchMock: vi.fn(),
    getDbMock: vi.fn(),
    appSqlMock: {
      reserve: vi.fn(),
    },
    createScopedDrizzleMock: vi.fn(),
  }))

vi.mock('$lib/server/boot', () => ({ bootApp: bootAppMock }))
const { findEditableTurnMock, replaceChatTurnMock, runtimeSupersedeMock } = vi.hoisted(() => ({
  findEditableTurnMock: vi.fn(),
  replaceChatTurnMock: vi.fn(),
  runtimeSupersedeMock: vi.fn(),
}))
// The chat_message side of an edit runs on real Postgres in turn-edit.integration.spec.ts.
vi.mock('$lib/server/chat/turn-edit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/chat/turn-edit')>()),
  findEditableTurn: findEditableTurnMock,
  replaceChatTurn: replaceChatTurnMock,
}))
const isUserAdminMock = vi.hoisted(() => vi.fn(async () => false))
/** The company's members (CB3): u1 and u2 are members without admin rights, owner-1 runs the company; anyone else is no member. */
const personForMock = vi.hoisted(() =>
  vi.fn(async (id: string) =>
    id === 'u1' || id === 'u2'
      ? { id, roles: ['member'] }
      : id === 'owner-1'
        ? { id, roles: ['admin', 'member'] }
        : null,
  ),
)
vi.mock('$lib/server/auth/user-role', () => ({ isUserAdmin: isUserAdminMock, personFor: personForMock }))
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
  getCurrentTraceGroupId: () => undefined,
}))
// What a reply cost (the trace's cost-log rows): a fixed answer, recorded per call.
const { readReplyCostMock } = vi.hoisted(() => ({
  readReplyCostMock: vi.fn(async (..._args: unknown[]) => ({ costUsd: 0.0042, tokens: 1234, modelCalls: 2 })),
}))
vi.mock('$lib/server/chat/reply-cost', () => ({
  runMeasuredTurn: async (fn: () => Promise<unknown>) => ({ value: await fn(), traceId: 'trace-1', tokens: 1234 }),
  readReplyCost: readReplyCostMock,
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

let kernelEvents: InMemoryEventSink

describe('POST /api/chat — harness dispatch', () => {
  beforeEach(() => {
    kernelEvents = new InMemoryEventSink()
    runtimeDispatchMock.mockReset()
    handoffDispatchMock.mockReset()
    runtimeSupersedeMock.mockReset()
    findEditableTurnMock.mockReset()
    replaceChatTurnMock.mockReset()
    bootAppMock.mockReset()
    getDbMock.mockReset()
    appSqlMock.reserve.mockReset()
    createScopedDrizzleMock.mockReset()
    bootAppMock.mockResolvedValue({
      kernel: { eventSink: kernelEvents },
      orchestrator: {
        runtime: {
          dispatch: runtimeDispatchMock,
          dispatchOnboardingHandoff: handoffDispatchMock,
          supersedeTurn: runtimeSupersedeMock,
        },
      },
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

  it('onboarding hand-off: the agent speaks first — no user message, the runtime hand-off dispatch', async () => {
    const { POST } = await import('./+server')
    handoffDispatchMock.mockResolvedValue('You did it. Website first?')

    const res = await POST({
      locals: { user: { id: 'u1' } },
      request: ndjsonRequest({ bootstrap: true, onboardingHandoff: true }),
    } as never)

    const lines = await readNdjsonLines(res)
    expect(runtimeDispatchMock).not.toHaveBeenCalled()
    expect(handoffDispatchMock).toHaveBeenCalledTimes(1)
    const [sessionId, sinks, dispatchOptions] = handoffDispatchMock.mock.calls[0]
    expect(sessionId).toBe(SESSION_ID)
    expect(typeof sinks.stream).toBe('function')
    expect(dispatchOptions).toEqual({ person: { id: 'u1', roles: ['member'] } })
    expect(lines.at(-1)).toMatchObject({ type: 'done', response: 'You did it. Website first?' })
  })

  it('rejects onboardingHandoff without bootstrap (it is never user speech)', async () => {
    const { POST } = await import('./+server')
    await expect(
      POST({
        locals: { user: { id: 'u1' } },
        request: ndjsonRequest({ message: 'hi', onboardingHandoff: true }),
      } as never),
    ).rejects.toMatchObject({ status: 400 })
  })

  describe('owner-decision continuation (approval card → the agent continues)', () => {
    const decided = {
      id: 'apr-1',
      toolName: 'website.publish_page',
      input: {},
      principalId: 'orchestrator',
      status: 'approved',
    }
    function withRegistry(rows: unknown[]) {
      const execute = vi.fn(async () => rows)
      bootAppMock.mockResolvedValue({
        kernel: { eventSink: kernelEvents, registry: { execute } },
        orchestrator: {
          runtime: { dispatch: runtimeDispatchMock, dispatchOnboardingHandoff: handoffDispatchMock },
        },
      })
      return execute
    }

    it('dispatches a system turn naming the decision so the agent re-runs the gated step', async () => {
      const { POST } = await import('./+server')
      isUserAdminMock.mockResolvedValue(true)
      withRegistry([decided])
      runtimeDispatchMock.mockResolvedValue('Published.')

      const res = await POST({
        locals: { user: { id: 'owner-1' } },
        request: ndjsonRequest({ bootstrap: true, approvalContinuation: 'apr-1' }),
      } as never)
      const lines = await readNdjsonLines(res)

      expect(runtimeDispatchMock).toHaveBeenCalledTimes(1)
      const message = runtimeDispatchMock.mock.calls[0][2] as string
      expect(message).toContain('approved')
      expect(message).toContain('website.publish_page')
      expect(message).toContain('apr-1')
      expect(lines.at(-1)).toMatchObject({ type: 'done', response: 'Published.' })
    })

    it('owner/admin only, and only for a decided request', async () => {
      const { POST } = await import('./+server')
      isUserAdminMock.mockResolvedValue(false)
      withRegistry([decided])
      await expect(
        POST({
          locals: { user: { id: 'u2' } },
          request: ndjsonRequest({ bootstrap: true, approvalContinuation: 'apr-1' }),
        } as never),
      ).rejects.toMatchObject({ status: 403 })

      isUserAdminMock.mockResolvedValue(true)
      withRegistry([{ ...decided, status: 'pending' }])
      await expect(
        POST({
          locals: { user: { id: 'owner-1' } },
          request: ndjsonRequest({ bootstrap: true, approvalContinuation: 'apr-1' }),
        } as never),
      ).rejects.toMatchObject({ status: 409 })

      withRegistry([])
      await expect(
        POST({
          locals: { user: { id: 'owner-1' } },
          request: ndjsonRequest({ bootstrap: true, approvalContinuation: 'apr-1' }),
        } as never),
      ).rejects.toMatchObject({ status: 404 })
      await expect(
        POST({
          locals: { user: { id: 'owner-1' } },
          request: ndjsonRequest({ message: 'x', approvalContinuation: 'apr-1' }),
        } as never),
      ).rejects.toMatchObject({ status: 400 })
      expect(runtimeDispatchMock).not.toHaveBeenCalled()
    })
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

  it('dispatches through the kernel runtime as the SIGNED-IN MEMBER (their roles, never the admin agent) with the session and sinks', async () => {
    const { POST } = await import('./+server')
    runtimeDispatchMock.mockResolvedValue('Runtime reply.')

    const res = await POST({
      locals: { user: { id: 'u1' } },
      request: ndjsonRequest({ message: 'hello' }),
    } as never)

    await res.text()
    expect(bootAppMock).toHaveBeenCalledTimes(1)
    expect(runtimeDispatchMock).toHaveBeenCalledTimes(1)
    const [agentId, dispatchSessionId, message, sinks, dispatchOptions] =
      runtimeDispatchMock.mock.calls[0]
    expect(agentId).toBe('orchestrator')
    expect(dispatchSessionId).toBe(SESSION_ID)
    expect(message).toBe('hello')
    expect(typeof sinks.stream).toBe('function')
    expect(typeof sinks.surfaceEvent).toBe('function')
    // CB3: the person the brain acts as — a member's own roles, no 'admin', no agent identity.
    // The turn is tagged with the stored user message (edit-and-resend finds it by that).
    expect(dispatchOptions).toEqual({ person: { id: 'u1', roles: ['member'] }, turnId: expect.any(String) })
  })

  it('refuses a signed-in account that is not a member: the brain never runs (no fallback identity)', async () => {
    const { POST } = await import('./+server')
    await expect(
      POST({
        locals: { user: { id: 'stranger' } },
        request: ndjsonRequest({ message: 'hello' }),
      } as never),
    ).rejects.toMatchObject({ status: 403 })
    expect(runtimeDispatchMock).not.toHaveBeenCalled()
    expect(bootAppMock).not.toHaveBeenCalled()
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
          stepId: 'step-1',
          tool: 'email.send_mail',
          inputSummary: 'to: a@b.c',
        })
        sinks.surfaceEvent({
          type: 'tool.finished',
          stepId: 'step-1',
          tool: 'email.send_mail',
          failed: false,
          resultSummary: 'status: sent',
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
      stepId: 'step-1',
      tool: 'email.send_mail',
      inputSummary: 'to: a@b.c',
    })
    expect(lines).toContainEqual(expect.objectContaining({ type: 'tool.finished', stepId: 'step-1', failed: false }))
    expect(lines).toContainEqual({ type: 'message_delta', content: 'Hello ' })
    expect(lines).toContainEqual({ type: 'message_delta', content: 'there.' })
    const last = lines[lines.length - 1]
    expect(last.type).toBe('done')
    expect(last.response).toBe('Hello there.')
    expect(last.sessionId).toBe(SESSION_ID)
    // What the reply cost: read from the reply's own trace, sent with done.
    expect(readReplyCostMock).toHaveBeenCalledWith(streamDb, 'u1', { value: 'Hello there.', traceId: 'trace-1', tokens: 1234 })
    expect(last.usage).toEqual({ costUsd: 0.0042, tokens: 1234, modelCalls: 2 })
    // One row per tool step (its end folded in) + the final reply carrying its cost.
    const rows = (insertMock.mock.results[0]!.value as { values: ReturnType<typeof vi.fn> }).values.mock.calls.map(
      (call) => call[0] as { content: string; metadata?: Record<string, unknown> },
    )
    expect(rows).toContainEqual(
      expect.objectContaining({
        content: 'to: a@b.c',
        metadata: expect.objectContaining({ variant: 'tool_preview', tool: 'email.send_mail', stepId: 'step-1', status: 'done', resultSummary: 'status: sent' }),
      }),
    )
    expect(rows).toContainEqual(
      expect.objectContaining({
        content: 'Hello there.',
        metadata: expect.objectContaining({ usage: { costUsd: 0.0042, tokens: 1234, modelCalls: 2 } }),
      }),
    )
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
        sinks.surfaceEvent({ type: 'approval.required', tool: 'email.send_mail', approvalId: 'apr-1' })
        return 'Queued for owner approval.'
      },
    )
    const streamDb = buildStreamDb()
    createScopedDrizzleMock.mockReturnValue(streamDb)

    const res = await POST({
      locals: { user: { id: 'u1' } },
      request: ndjsonRequest({ message: 'send it' }),
    } as never)

    const lines = await readNdjsonLines(res)
    expect(lines).toContainEqual({
      type: 'approval.required',
      tool: 'email.send_mail',
      approvalId: 'apr-1',
    })
    // The card's request id is saved with the transcript (page-load restore decides by it).
    const stored = streamDb.insert.mock.results
      .flatMap((r) => (r.value as { values: ReturnType<typeof vi.fn> }).values.mock.calls)
      .map((c) => c[0] as { metadata?: Record<string, unknown> })
    expect(stored.map((v) => v.metadata)).toContainEqual({
      variant: 'approval_required',
      tool: 'email.send_mail',
      approvalId: 'apr-1',
      turnOf: expect.any(String),
    })
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
    const body = await res.json()
    expect(body).toMatchObject({
      response: CHAT_TURN_FAILED_MESSAGE,
      sessionId: SESSION_ID,
      history: [],
    })
    expect(JSON.stringify(body)).not.toContain('gateway timeout')
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
    // One fixed, human message — the raw error never reaches the client.
    expect(last.error).toBe(CHAT_TURN_FAILED_MESSAGE)
    expect(JSON.stringify(lines)).not.toContain('embedding failed')
    // ...but the server log has the details, and the operator record exists.
    expect(JSON.stringify(consoleSpy.mock.calls)).toContain('embedding failed')
    const recorded = kernelEvents.events.filter((e) => e.type === 'harness.turn_failed')
    expect(recorded).toHaveLength(1)
    expect(JSON.stringify(recorded[0]!.payload)).toContain('embedding failed')
    consoleSpy.mockRestore()
  })

  it('a failing journey step: the user gets the agent reply and no error text', async () => {
    const { POST } = await import('./+server')
    // Real journey-aware runtime on a kernel WITHOUT the website/admin tools —
    // the production incident ("unknown tool: kernel.module_activate").
    const sink = new InMemoryEventSink()
    const journeys = new InMemoryJourneyStore()
    const registry = new KernelRegistry({ eventSink: sink, vcsCommitter: null })
    registry.register({
      name: 'website.list_pages',
      module: 'website',
      summary: 'list',
      auditClass: 'read',
      inputSchema: z.looseObject({}),
      permission: { roles: ['admin'] },
      handler: async () => {
        throw new Error('unknown tool: kernel.module_activate')
      },
    })
    const runtime = new JourneyAwareAgentRuntime({
      registry,
      isToolActive: async () => true,
      eventSink: sink,
      journeys,
      spec: WEBSITE_FOUNDING_JOURNEY,
    })
    const modelInputs: string[] = []
    const replies = [
      'Got it! [[journey:company_name:captured]]',
      'Noted. [[journey:positioning:captured]]',
      'I could not set up your pages just yet — I will try again on your next message.',
    ]
    runtime.registerEngine('durable', {
      run: async (_s, input) => {
        modelInputs.push(input)
        return replies.shift()!
      },
    })
    runtime.registerAgent(orchestratorAgentConfig())
    await journeys.create(WEBSITE_FOUNDING_JOURNEY.kind, initialJourneyState(SESSION_ID, WEBSITE_FOUNDING_JOURNEY.specVersion))
    await runtime.dispatch('orchestrator', SESSION_ID, 'Acme', undefined, { person: { id: 'u1', roles: ['admin', 'member'] } })
    bootAppMock.mockResolvedValue({ kernel: { eventSink: kernelEvents }, orchestrator: { runtime } })

    // The owner's turn (an admin): the journey step runs as them and reaches the website tool.
    const res = await POST({
      locals: { user: { id: 'owner-1' } },
      request: ndjsonRequest({ message: 'We build things.' }),
    } as never)

    const lines = await readNdjsonLines(res)
    const last = lines.at(-1)!
    expect(last).toMatchObject({
      type: 'done',
      response: 'I could not set up your pages just yet — I will try again on your next message.',
    })
    expect(lines.some((l) => l.type === 'error')).toBe(false)
    expect(JSON.stringify(lines)).not.toContain('unknown tool')
    // The model saw the failure as information.
    expect(modelInputs.at(-1)).toContain('unknown tool: kernel.module_activate')
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

  describe('attached files (Contribute: attach documents in the AI assistant)', () => {
    const notes = { name: 'notes.md', kind: 'text', sizeBytes: 21, text: 'Ship the bakery site.' }
    const report = { name: 'q3.pdf', kind: 'pdf', sizeBytes: 4096, text: 'Revenue grew 12%.' }

    it('the text of the files reaches the model with the message; the stored turn keeps only name, kind, size', async () => {
      const { POST } = await import('./+server')
      runtimeDispatchMock.mockResolvedValue('Read them.')
      const db = buildMainDb()
      getDbMock.mockReturnValue(db)

      const res = await POST({
        locals: { user: { id: 'u1' } },
        request: ndjsonRequest({ message: 'Summarise these.', attachments: [notes, report] }),
      } as never)
      await res.text()

      const message = runtimeDispatchMock.mock.calls[0]![2] as string
      expect(message.startsWith('Summarise these.')).toBe(true)
      expect(message).toContain('<attached_file name="notes.md"')
      expect(message).toContain('Ship the bakery site.')
      expect(message).toContain('<attached_file name="q3.pdf"')
      expect(message).toContain('Revenue grew 12%.')

      const values = (db.insert.mock.results[1]!.value as { values: ReturnType<typeof vi.fn> })
        .values
      const userRow = values.mock.calls[1]![0] as Record<string, unknown>
      expect(userRow).toMatchObject({ role: 'user', content: 'Summarise these.' })
      expect(userRow.metadata).toEqual({
        attachments: [
          { name: 'notes.md', kind: 'text', sizeBytes: 21 },
          { name: 'q3.pdf', kind: 'pdf', sizeBytes: 4096 },
        ],
      })
      expect(JSON.stringify(userRow)).not.toContain('Revenue grew')
    })

    it('a message may be files alone', async () => {
      const { POST } = await import('./+server')
      runtimeDispatchMock.mockResolvedValue('Got it.')
      const res = await POST({
        locals: { user: { id: 'u1' } },
        request: ndjsonRequest({ message: '', attachments: [notes] }),
      } as never)
      await res.text()
      expect(runtimeDispatchMock.mock.calls[0]![2]).toContain('Ship the bakery site.')
    })

    it('refuses malformed or oversized attachments before the agent runs, and on app-made turns', async () => {
      const { POST } = await import('./+server')
      await expect(
        POST({
          locals: { user: { id: 'u1' } },
          request: ndjsonRequest({ message: 'x', attachments: [{ name: 'x' }] }),
        } as never),
      ).rejects.toMatchObject({ status: 400 })
      await expect(
        POST({
          locals: { user: { id: 'u1' } },
          request: ndjsonRequest({
            message: 'x',
            attachments: Array.from({ length: 6 }, () => notes),
          }),
        } as never),
      ).rejects.toMatchObject({ status: 413 })
      await expect(
        POST({
          locals: { user: { id: 'u1' } },
          request: ndjsonRequest({ bootstrap: true, onboardingHandoff: true, attachments: [notes] }),
        } as never),
      ).rejects.toMatchObject({ status: 400 })
      expect(runtimeDispatchMock).not.toHaveBeenCalled()
      expect(handoffDispatchMock).not.toHaveBeenCalled()
    })
  })

  describe('edit-and-resend (board a950ef11: edit the message after stopping, send it again)', () => {
    const OLD_ID = 'msg-old'

    function editRequest(body: Record<string, unknown> = {}) {
      return ndjsonRequest({ message: 'the edited words', sessionId: SESSION_ID, replacesMessageId: OLD_ID, ...body })
    }

    it('every member turn announces its stored message first, and its rows belong to that turn', async () => {
      const { POST } = await import('./+server')
      runtimeDispatchMock.mockResolvedValue('Reply.')
      const streamDb = buildStreamDb()
      createScopedDrizzleMock.mockReturnValue(streamDb)
      const db = buildMainDb()
      getDbMock.mockReturnValue(db)

      const res = await POST({ locals: { user: { id: 'u1' } }, request: ndjsonRequest({ message: 'hello' }) } as never)
      const lines = await readNdjsonLines(res)

      const userRow = (db.insert.mock.results[1]!.value as { values: ReturnType<typeof vi.fn> }).values.mock
        .calls[1]![0] as { id: string; role: string }
      expect(userRow.role).toBe('user')
      expect(lines[0]).toEqual({ type: 'turn.accepted', sessionId: SESSION_ID, messageId: userRow.id })
      expect(runtimeDispatchMock.mock.calls[0]![4]).toMatchObject({ turnId: userRow.id })
      const values = (streamDb.insert.mock.results[0]!.value as { values: ReturnType<typeof vi.fn> }).values
      const answer = values.mock.calls.at(-1)![0] as { metadata?: unknown }
      expect(answer.metadata).toEqual({ turnOf: userRow.id, usage: { costUsd: 0.0042, tokens: 1234, modelCalls: 2 } })
    })

    it('replaces the latest turn: the model side first, then the transcript, then the edited request runs', async () => {
      const { POST } = await import('./+server')
      const order: string[] = []
      findEditableTurnMock.mockImplementation(async () => {
        order.push('check')
        return { messageId: OLD_ID, isFirst: false }
      })
      runtimeSupersedeMock.mockImplementation(async () => void order.push('supersede'))
      replaceChatTurnMock.mockImplementation(async () => {
        order.push('replace')
      })
      runtimeDispatchMock.mockImplementation(async () => {
        order.push('dispatch')
        return 'Better answer.'
      })

      const res = await POST({ locals: { user: { id: 'u1' } }, request: editRequest() } as never)
      const lines = await readNdjsonLines(res)

      expect(order).toEqual(['check', 'supersede', 'replace', 'dispatch'])
      expect(findEditableTurnMock.mock.calls[0]![1]).toEqual({ sessionId: SESSION_ID, userId: 'u1', messageId: OLD_ID })
      const [agentId, sessionId, turnId, replacementTurnId, options] = runtimeSupersedeMock.mock.calls[0]!
      expect([agentId, sessionId, turnId]).toEqual(['orchestrator', SESSION_ID, OLD_ID])
      expect(options).toEqual({ person: { id: 'u1', roles: ['member'] } })
      expect(replaceChatTurnMock.mock.calls[0]![1]).toEqual({
        sessionId: SESSION_ID,
        userId: 'u1',
        replacesMessageId: OLD_ID,
        replacementId: replacementTurnId,
        content: 'the edited words',
        metadata: null,
      })
      expect(runtimeDispatchMock.mock.calls[0]![2]).toBe('the edited words')
      expect(runtimeDispatchMock.mock.calls[0]![4]).toMatchObject({ turnId: replacementTurnId })
      expect(lines[0]).toEqual({ type: 'turn.accepted', sessionId: SESSION_ID, messageId: replacementTurnId })
      expect(lines.at(-1)).toMatchObject({ type: 'done', response: 'Better answer.' })
    })

    it('a message that is no longer editable is refused before anything changes (409, fixed words)', async () => {
      const { POST } = await import('./+server')
      const { TurnNotEditableError } = await import('$lib/server/chat/turn-edit')
      findEditableTurnMock.mockRejectedValue(new TurnNotEditableError('not the latest message'))
      await expect(POST({ locals: { user: { id: 'u1' } }, request: editRequest() } as never)).rejects.toMatchObject({
        status: 409,
        body: { message: 'This message can no longer be edited. Send a new message instead.' },
      })
      expect(runtimeSupersedeMock).not.toHaveBeenCalled()
      expect(replaceChatTurnMock).not.toHaveBeenCalled()
      expect(runtimeDispatchMock).not.toHaveBeenCalled()
    })

    it('a turn the model transcript does not carry (sent before edits existed) is refused, the transcript untouched', async () => {
      const { POST } = await import('./+server')
      const { KernelError } = await import('$lib/kernel/errors')
      findEditableTurnMock.mockResolvedValue({ messageId: OLD_ID, isFirst: false })
      runtimeSupersedeMock.mockRejectedValue(new KernelError('turn_not_editable', 'not in the model context'))
      await expect(POST({ locals: { user: { id: 'u1' } }, request: editRequest() } as never)).rejects.toMatchObject({
        status: 409,
      })
      expect(replaceChatTurnMock).not.toHaveBeenCalled()
      expect(runtimeDispatchMock).not.toHaveBeenCalled()
    })

    it('an edit names a stored message of a stored session, and is never an app-made turn', async () => {
      const { POST } = await import('./+server')
      for (const body of [
        { message: 'x', replacesMessageId: OLD_ID },
        { message: 'x', sessionId: SESSION_ID, replacesMessageId: '' },
        { bootstrap: true, onboardingHandoff: true, sessionId: SESSION_ID, replacesMessageId: OLD_ID },
      ]) {
        await expect(
          POST({ locals: { user: { id: 'u1' } }, request: ndjsonRequest(body) } as never),
          JSON.stringify(body),
        ).rejects.toMatchObject({ status: 400 })
      }
      expect(runtimeSupersedeMock).not.toHaveBeenCalled()
      expect(runtimeDispatchMock).not.toHaveBeenCalled()
    })

    it('editing the first message re-titles the conversation with the edited words', async () => {
      const { POST } = await import('./+server')
      findEditableTurnMock.mockResolvedValue({ messageId: OLD_ID, isFirst: true })
      runtimeSupersedeMock.mockResolvedValue(undefined)
      replaceChatTurnMock.mockResolvedValue(undefined)
      runtimeDispatchMock.mockResolvedValue('ok')
      const streamDb = buildStreamDb()
      createScopedDrizzleMock.mockReturnValue(streamDb)
      const res = await POST({ locals: { user: { id: 'u1' } }, request: editRequest() } as never)
      await res.text()
      const set = (streamDb.update.mock.results[0]!.value as { set: ReturnType<typeof vi.fn> }).set
      expect(set).toHaveBeenCalledWith({ title: 'the edited words' })
    })
  })
})
