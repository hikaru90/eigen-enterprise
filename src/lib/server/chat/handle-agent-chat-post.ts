import type { RequestEvent } from '@sveltejs/kit'
import { error, json } from '@sveltejs/kit'
import { and, eq, sql } from 'drizzle-orm'
import { formatToolResultForDisplay, sanitizeFinalAnswerText } from '$lib/chat/chat-stream-types'
import { compactChatIntermediateSteps } from '$lib/chat/normalize-messages'
import type { EngineSurfaceEvent } from '$lib/kernel/engine'
import { runWithTrace } from '$lib/server/activity/trace-context'
import {
  appDbAsyncLocal,
  appSql,
  createScopedDrizzle,
  getDb,
  activateTenantDbSession,
  deactivateTenantDbSession,
} from '$lib/server/db'
import { chatSession, chatMessage, type ChatSessionMode } from '$lib/server/db/brain.schema'
import { tenantUserAsyncLocal } from '$lib/server/db/tenant-context'
import { isLlmNotConfiguredError } from '$lib/server/llm/errors'
import { redactForLog } from '$lib/server/observability/redact-for-log'

function collectErrorMessages(input: unknown): string[] {
  const parts: string[] = []
  let current = input
  let guard = 0
  while (current && guard < 8) {
    guard += 1
    if (current instanceof Error) {
      parts.push(current.message)
      current = current.cause
      continue
    }
    if (typeof current === 'object' && current) {
      const msg = 'message' in current ? (current as { message?: unknown }).message : undefined
      if (typeof msg === 'string' && msg.trim().length > 0) {
        parts.push(msg)
      }
      current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined
      continue
    }
    break
  }
  return parts.filter((v, i, arr) => v && arr.indexOf(v) === i)
}

/**
 * THE BOUNDARY (code <-> harness <-> user): the chat entry hands the message
 * to the harness and streams the harness's reply. Application failures inside
 * the turn are the agent's to handle (modules/orchestrator/brain.ts hands them
 * back as observations). Only a failure of the harness/LLM itself — or of this
 * entry's own bookkeeping — ends the turn without the agent; the user then
 * sees ONE fixed, human message. The real error is logged server-side
 * (redacted) and recorded for the operator; no raw error text ever reaches
 * the client.
 */
export const CHAT_TURN_FAILED_MESSAGE =
  'Something went wrong on my side and I could not finish that. The team can see what happened — please try again in a moment.'

/** Fixed message when no AI provider is set up (the surface offers the setup door via `code`). */
export const CHAT_LLM_NOT_CONFIGURED_MESSAGE =
  'I can’t answer yet — no AI provider is set up for this company. Set one up and we can start.'

/** Fixed message when the turn stopped without an answer (stream closed early). */
export const CHAT_TURN_INCOMPLETE_MESSAGE =
  'The answer was cut off before it finished. Please try again.'

/** Operator record of a turn that ended without the agent (kernel event in production). */
export type ChatTurnFailureRecord = {
  logTag: string
  sessionId: string
  userId: string
  code: 'llm_not_configured' | 'turn_failed'
  details: string[]
}

export function chatErrorTerminalPayload(err: unknown): {
  type: 'error'
  error: string
  code?: string
} {
  // Structured kind for user-facing surfaces ("Set up your AI provider" door) — typed
  // detection, never message string matching.
  if (isLlmNotConfiguredError(err)) {
    return { type: 'error', error: CHAT_LLM_NOT_CONFIGURED_MESSAGE, code: 'llm_not_configured' }
  }
  return { type: 'error', error: CHAT_TURN_FAILED_MESSAGE }
}

/** Server-side record of a harness failure: redacted log + operator record. Never throws. */
async function reportTurnFailure(
  options: HandleAgentChatPostOptions,
  input: { err: unknown; sessionId: string; userId: string },
): Promise<void> {
  const logTag = options.logTag ?? 'api/chat'
  const details = collectErrorMessages(input.err)
  const record: ChatTurnFailureRecord = {
    logTag,
    sessionId: input.sessionId,
    userId: input.userId,
    code: isLlmNotConfiguredError(input.err) ? 'llm_not_configured' : 'turn_failed',
    details,
  }
  console.error(`[${logTag}] harness turn failed`, redactForLog(record))
  try {
    await options.recordFailure(record)
  } catch (recordErr) {
    console.error(`[${logTag}] could not record the turn failure`, {
      error: recordErr instanceof Error ? recordErr.message : String(recordErr),
    })
  }
}

export const BRIEFING_BOOTSTRAP_MESSAGES: Record<string, string> = {
  morning:
    "Give my morning briefing: today's agenda, top 3 priorities, and open loops. Use list_projects and get_project_timeline for project agendas, answer_question for priorities/open loops, and retrieve_thoughts only to browse recent thoughts. Be calm and concise.",
  evening:
    'Give my evening review: what was completed today, what rolls over, and gentle suggestions for tomorrow. Use list_projects and get_project_timeline for project status, and answer_question for what completed or rolls over.',
  weekly:
    'Give my weekly review: completions this week, overdue debt, patterns, and 2–3 focus suggestions for next week. Use list_projects, get_project_timeline, answer_question, and retrieve_thoughts only to browse recent thoughts.',
}

async function getOrCreateSession(
  db: ReturnType<typeof getDb>,
  userId: string,
  sessionId: string | null,
  mode: ChatSessionMode,
): Promise<{ sessionId: string; mode: ChatSessionMode }> {
  if (!sessionId) {
    const [s] = await db
      .insert(chatSession)
      .values({
        userId,
        mode,
        title: '',
      })
      .returning({ id: chatSession.id, mode: chatSession.mode })
    return { sessionId: s.id, mode: s.mode }
  }
  const [existing] = await db
    .select({ id: chatSession.id, mode: chatSession.mode })
    .from(chatSession)
    .where(and(eq(chatSession.id, sessionId), eq(chatSession.userId, userId)))
    .limit(1)
  if (!existing) error(404, 'Session not found') // also when it belongs to someone else
  if (existing.mode !== mode) {
    error(400, `Session mode mismatch: expected ${mode}`)
  }
  return { sessionId, mode: existing.mode }
}

async function persistAssistantMessage(
  db: ReturnType<typeof getDb>,
  sessionId: string,
  userId: string,
  content: string,
  metadata?: Record<string, unknown> | null,
) {
  const [msg] = await db
    .insert(chatMessage)
    .values({ sessionId, userId, role: 'assistant', content, ...(metadata ? { metadata } : {}) })
    .returning({ id: chatMessage.id })
  return msg.id
}

/**
 * Persist a completed streamed turn in live-UI order: compacted tool/thinking steps,
 * then the final assistant text. Callers should emit `done` after this returns.
 */
export async function persistStreamedAssistantTurn(input: {
  db: ReturnType<typeof getDb>
  sessionId: string
  userId: string
  responseText: string
  intermediateSteps: Array<{ content: string; metadata: Record<string, unknown> }>
}): Promise<{ messageId: string; storedStepCount: number }> {
  const storedSteps = compactChatIntermediateSteps(input.intermediateSteps)
  for (const step of storedSteps) {
    await input.db.insert(chatMessage).values({
      sessionId: input.sessionId,
      userId: input.userId,
      role: 'assistant',
      content: step.content,
      metadata: step.metadata,
    })
  }
  const messageId = await persistAssistantMessage(
    input.db,
    input.sessionId,
    input.userId,
    input.responseText,
  )
  return { messageId, storedStepCount: storedSteps.length }
}

export type AgentChatPostBody = {
  message?: unknown
  history?: unknown
  sessionId?: unknown
  mode?: unknown
  bootstrap?: unknown
  briefingPeriod?: unknown
  /** Assisted-onboarding hand-off bootstrap (POST /api/chat only). */
  onboardingHandoff?: unknown
  /** Owner-decision continuation: the decided approval id (POST /api/chat only). */
  approvalContinuation?: unknown
}

/**
 * The one agent path: a kernel AgentRuntime dispatch (harness). Implementations
 * resolve the runtime + agent id (composition root); the handler owns session
 * persistence, NDJSON framing, and terminal semantics. `userId` is the
 * authenticated human — attribution for the run's LLM calls (BYOK config).
 */
export type AgentChatDispatch = (
  sessionId: string,
  message: string,
  sinks: {
    stream: (delta: string) => void
    surfaceEvent: (event: EngineSurfaceEvent) => void
  },
  userId: string,
) => Promise<string>

export type HandleAgentChatPostOptions = {
  /** Fixed session mode for this endpoint. */
  sessionMode: ChatSessionMode
  /** The harness dispatch (AgentRuntime.dispatch for the orchestrator agent). */
  dispatch: AgentChatDispatch
  /** Resolve the user message sent to the agent (bootstrap or typed). */
  resolveAgentUserMessage: (input: {
    bootstrap: boolean
    message: string
    briefingPeriod: string
  }) => string
  logTag?: string
  /**
   * Records a turn that ended without the agent (harness/LLM failure) where
   * the operator can see it. Required: no silent failures.
   */
  recordFailure: (record: ChatTurnFailureRecord) => Promise<void>
}

export async function handleAgentChatPost(
  event: RequestEvent,
  body: AgentChatPostBody,
  options: HandleAgentChatPostOptions,
) {
  const user = event.locals.user
  if (!user) {
    console.error(`[${options.logTag ?? 'api/chat'}] no user`)
    error(401, 'Unauthorized')
  }

  const bootstrap = body.bootstrap === true
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  const briefingPeriod = typeof body.briefingPeriod === 'string' ? body.briefingPeriod.trim() : ''

  if (!message && !bootstrap) {
    console.error(`[${options.logTag ?? 'api/chat'}] empty message`)
    error(400, 'message is required')
  }

  const agentUserMessage = options.resolveAgentUserMessage({ bootstrap, message, briefingPeriod })

  const db = getDb()
  const sessionKey =
    typeof body.sessionId === 'string' && body.sessionId.trim() ? body.sessionId.trim() : null
  // Mode mismatch still fails loud (400) inside getOrCreateSession.
  const { sessionId } = await getOrCreateSession(db, user.id, sessionKey, options.sessionMode)

  if (!bootstrap) {
    await db.insert(chatMessage).values({
      sessionId,
      userId: user.id,
      role: 'user',
      content: message,
    })
  }

  const countResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(chatMessage)
    .where(eq(chatMessage.sessionId, sessionId))
  const isFirstMessage = bootstrap || countResult[0]?.count === 1

  const accept = event.request.headers?.get('accept') ?? ''
  const streamNdjson = accept.includes('application/x-ndjson')

  if (streamNdjson) {
    const encoder = new TextEncoder()
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>(
      {},
      { highWaterMark: 64 },
    )
    const writer = writable.getWriter()

    let terminalSent = false
    let streamClosed = false

    const writeLine = (payload: unknown) => {
      if (streamClosed) return
      void writer.write(encoder.encode(`${JSON.stringify(payload)}\n`)).catch(() => {
        streamClosed = true
      })
    }

    const sendTerminal = (payload: { type: 'done' | 'error'; [key: string]: unknown }) => {
      if (terminalSent) return
      terminalSent = true
      writeLine(payload)
    }

    const closeStream = async () => {
      if (streamClosed) return
      streamClosed = true
      await writer.close().catch(() => {})
    }

    event.request.signal.addEventListener('abort', () => {
      if (!terminalSent) {
        sendTerminal({ type: 'error', error: 'Request cancelled.' })
      }
      streamClosed = true
      void writer.abort(new Error('client disconnected')).catch(() => {})
    })

    const intermediateSteps: Array<{ content: string; metadata: Record<string, unknown> }> = []

    const recordIntermediateStep = (evt: {
      type: string
      content?: string
      tool?: string
      arguments?: Record<string, unknown>
      preview?: string
      failed?: boolean
      phase?: string
      label?: string
      inputSummary?: string | null
      approvalId?: string
    }) => {
      if (evt.type === 'thinking' && evt.content) {
        intermediateSteps.push({
          content: evt.content,
          metadata: { variant: 'thinking' },
        })
      } else if (evt.type === 'tool.preview') {
        intermediateSteps.push({
          content: evt.inputSummary ?? '',
          metadata: { variant: 'tool_preview', tool: evt.tool },
        })
      } else if (evt.type === 'approval.required') {
        intermediateSteps.push({
          content: '',
          metadata: { variant: 'approval_required', tool: evt.tool, approvalId: evt.approvalId },
        })
      } else if (evt.type === 'tool_call') {
        const args = evt.arguments ?? {}
        intermediateSteps.push({
          content: JSON.stringify({ tool: evt.tool, arguments: args }),
          metadata: { variant: 'tool_call', tool: evt.tool, arguments: args },
        })
      } else if (evt.type === 'tool_executing') {
        intermediateSteps.push({
          content: evt.tool ?? '',
          metadata: { variant: 'tool_executing', tool: evt.tool },
        })
      } else if (evt.type === 'tool_progress') {
        intermediateSteps.push({
          content: evt.label ?? '',
          metadata: {
            variant: 'tool_progress',
            tool: evt.tool,
            phase: evt.phase,
            label: evt.label,
          },
        })
      } else if (evt.type === 'tool_result') {
        const preview = evt.preview ?? ''
        const failed = evt.failed === true
        intermediateSteps.push({
          content: preview,
          metadata: {
            variant: 'tool_result',
            tool: evt.tool,
            failed,
            displaySummary: formatToolResultForDisplay(evt.tool ?? '', preview),
          },
        })
      }
    }

    const chatWork = (async () => {
      let reserved: Awaited<ReturnType<typeof appSql.reserve>> | null = null
      try {
        reserved = await appSql.reserve()
        await activateTenantDbSession(reserved, user.id)
        const scopedDb = createScopedDrizzle(reserved)

        // One path: the kernel harness. The reply text comes back from the
        // runtime; stream/surface events flow out through the sinks below.
        const reply = await tenantUserAsyncLocal.run(user.id, () =>
          appDbAsyncLocal.run(scopedDb, () =>
            runWithTrace(crypto.randomUUID(), () =>
              options.dispatch(sessionId, agentUserMessage, {
                stream: (delta) => {
                  if (!streamClosed) {
                    writeLine({ type: 'message_delta', content: delta })
                  }
                },
                surfaceEvent: (evt) => {
                  if (!streamClosed) {
                    writeLine(evt)
                  }
                  recordIntermediateStep(evt)
                },
              }, user.id),
            ),
          ),
        )

        const responseText = sanitizeFinalAnswerText(
          reply.trim().length > 0 ? reply : 'The assistant did not produce a response.',
        )
        const { messageId } = await persistStreamedAssistantTurn({
          db: scopedDb,
          sessionId,
          userId: user.id,
          responseText,
          intermediateSteps,
        })
        sendTerminal({
          type: 'done',
          response: responseText,
          sessionId,
          messageId,
        })

        if (isFirstMessage && !bootstrap && message.length > 0) {
          const title = message.length > 80 ? message.slice(0, 77) + '...' : message
          await scopedDb.update(chatSession).set({ title }).where(eq(chatSession.id, sessionId))
        }
      } catch (err) {
        await reportTurnFailure(options, { err, sessionId, userId: user.id })
        sendTerminal(chatErrorTerminalPayload(err))
      } finally {
        if (reserved) {
          await deactivateTenantDbSession(reserved).catch(() => {})
          await reserved.release()
        }
        if (!terminalSent) {
          sendTerminal({ type: 'error', error: CHAT_TURN_INCOMPLETE_MESSAGE })
        }
        await closeStream()
      }
    })()

    chatWork.catch(async (err: unknown) => {
      await reportTurnFailure(options, { err, sessionId, userId: user.id })
      if (!terminalSent) {
        sendTerminal({ type: 'error', error: CHAT_TURN_INCOMPLETE_MESSAGE })
      }
      void closeStream()
    })

    return new Response(readable, {
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
    })
  }

  try {
    const reply = await runWithTrace(crypto.randomUUID(), () =>
      options.dispatch(sessionId, agentUserMessage, {
        stream: () => {},
        surfaceEvent: () => {},
      }, user.id),
    )

    const responseText = sanitizeFinalAnswerText(
      reply.trim().length > 0 ? reply : 'The assistant did not produce a response.',
    )
    const messageId = await persistAssistantMessage(db, sessionId, user.id, responseText)

    if (isFirstMessage && !bootstrap && message.length > 0) {
      const title = message.length > 80 ? message.slice(0, 77) + '...' : message
      await db.update(chatSession).set({ title }).where(eq(chatSession.id, sessionId))
    }

    return json({
      response: responseText,
      history: [],
      sessionId,
      messageId,
    })
  } catch (err) {
    await reportTurnFailure(options, { err, sessionId, userId: user.id })
    const payload = chatErrorTerminalPayload(err)
    return json(
      {
        response: payload.error,
        history: [],
        sessionId,
        ...(payload.code ? { code: payload.code } : {}),
      },
      { status: 500 },
    )
  }
}
