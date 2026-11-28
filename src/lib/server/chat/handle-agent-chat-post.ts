import type { RequestEvent } from '@sveltejs/kit'
import { error, json } from '@sveltejs/kit'
import { and, eq, sql } from 'drizzle-orm'
import type { ReplyCost } from '$lib/ai-usage/usage'
import { formatToolResultForDisplay, sanitizeFinalAnswerText } from '$lib/chat/chat-stream-types'
import { compactChatIntermediateSteps } from '$lib/chat/normalize-messages'
import type { AgentReport } from '$lib/errors/agent-report'
import type { EngineSurfaceEvent } from '$lib/kernel/engine'
import { DurableRunError } from '$lib/kernel/engines/durable'
import { KernelError } from '$lib/kernel/errors'
import {
  AssistantAttachmentError,
  attachmentMetadata,
  composeAgentMessage,
  parseChatAttachments,
} from '$lib/server/assistant/attachments'
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
import { errorReport } from '$lib/server/errors/report'
import { EmptyReplyError, emptyReplyReport, emptyReplySentence, findEmptyReplyError } from '$lib/server/llm/empty-reply'
import {
  dailyCapErrorMessage,
  isLlmCutShortError,
  isLlmDailyCapError,
  isLlmNotConfiguredError,
  LLM_CUT_SHORT_MESSAGE,
  LLM_DAILY_CAP_MESSAGE,
} from '$lib/server/llm/errors'
import { requestAiContextAsyncLocal } from '$lib/server/llm/request-context'
import { redactForLog } from '$lib/server/observability/redact-for-log'
import { readReplyCost, runMeasuredTurn } from './reply-cost'
import {
  findEditableTurn,
  replaceChatTurn,
  TURN_NOT_EDITABLE_MESSAGE,
  TurnNotEditableError,
  type EditableTurn,
} from './turn-edit'

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

/** Fixed message when the turn was stopped (the person edited it and sent it again). */
export const CHAT_TURN_STOPPED_MESSAGE = 'This reply was stopped.'

/**
 * The durable run was aborted: the only abort is edit-and-resend stopping the
 * turn it replaces (AgentRuntime.supersedeTurn) — the person's choice, not a
 * failure for the operator. pi-durable's structured reason, never message text.
 */
function stoppedByEdit(err: unknown): boolean {
  return err instanceof DurableRunError && err.reason === 'aborted'
}

/** Operator record of a turn that ended without the agent (kernel event in production). */
export type ChatTurnFailureRecord = {
  logTag: string
  sessionId: string
  userId: string
  code: 'llm_not_configured' | 'empty_reply' | 'turn_failed'
  details: string[]
  /** The agent report (src/lib/server/errors/report.ts): what was attempted, the cause chain, next steps. */
  agent?: AgentReport
}

/** The server-side agent report of a turn that ended without the agent's answer. */
export function chatTurnFailureReport(err: unknown): AgentReport {
  const attempted = 'Answering a message in the assistant chat (the kernel harness turn, src/lib/server/chat/handle-agent-chat-post.ts)'
  const empty = findEmptyReplyError(err)
  if (empty) return emptyReplyReport(empty, attempted).agent
  return errorReport(err, {
    attempted,
    nextSteps: [
      ...(isLlmCutShortError(err)
        ? [
            'Every attempt of the model call ended on finish_reason length below our max_tokens (LlmCutShortError, src/lib/server/llm/llm-client.ts cutShortBelowBudget): the provider capped the output. Check the provider\'s output limit for the routed model against DEFAULT_CHAT_MAX_TOKENS, and the AI usage rows of the trace (completion tokens per attempt).',
          ]
        : []),
      'The harness turn threw before the agent could answer; `cause` is the chain. Find the failing layer by the first message: the gateway (src/lib/server/llm/llm-client.ts), the durable engine (src/lib/server/agent/durable-harness.ts), or this entry\'s own bookkeeping (session, persist, cost read).',
    ],
  }).agent
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
  // The company's daily AI cap per member (DC3) or demo visitor's per-IP limit:
  // the person reads why, and when it resets.
  if (isLlmDailyCapError(err)) {
    return { type: 'error', error: dailyCapErrorMessage(err) ?? LLM_DAILY_CAP_MESSAGE, code: 'llm_daily_cap' }
  }
  // Wish c37fcfe6: a turn without an answer says why (length limit, filter, provider error, step limit…).
  const empty = findEmptyReplyError(err)
  if (empty) {
    return { type: 'error', error: emptyReplySentence(empty.emptyCause), code: 'empty_reply' }
  }
  // Wish 377f4843: since v0.5.44 a reply the provider cuts short is retried, and the last cut
  // fails the turn; that is the provider, not "something on my side" — say so.
  if (isLlmCutShortError(err)) {
    return { type: 'error', error: LLM_CUT_SHORT_MESSAGE, code: 'llm_cut_short' }
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
    code: isLlmNotConfiguredError(input.err) ? 'llm_not_configured' : findEmptyReplyError(input.err) ? 'empty_reply' : 'turn_failed',
    details,
    agent: chatTurnFailureReport(input.err),
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

/**
 * Briefing turns. They name only registry tools the brain is offered for every
 * member (CB3: all of them are member tools, read as the person — their own
 * Memory, tasks and calendar). Pinned by src/lib/server/chat/briefing-tools.spec.ts.
 */
export const BRIEFING_BOOTSTRAP_MESSAGES: Record<string, string> = {
  morning:
    "Give my morning briefing: today's agenda, top 3 priorities, and open loops. Use calendar.list for today's agenda, memory.list_projects and memory.get_project_timeline for project next actions and deadlines, tasks.list for the tasks assigned to and by me, and memory.retrieve_thoughts for recent thoughts and open loops. Be calm and concise.",
  evening:
    'Give my evening review: what was completed today, what rolls over, and gentle suggestions for tomorrow. Use memory.list_projects and memory.get_project_timeline for project status, tasks.list for assigned tasks, and memory.retrieve_thoughts for what I captured today.',
  weekly:
    'Give my weekly review: completions this week, overdue debt, patterns, and 2–3 focus suggestions for next week. Use memory.list_projects, memory.get_project_timeline, tasks.list, and memory.retrieve_thoughts for this week’s thoughts.',
}

/** The registry tools the briefing turns tell the brain to use (briefing-tools.spec.ts pins them to the registry). */
export const BRIEFING_TOOLS = [
  'calendar.list',
  'memory.list_projects',
  'memory.get_project_timeline',
  'tasks.list',
  'memory.retrieve_thoughts',
] as const

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
  /** The member message this reply answers (turn-edit.ts `turnOf`); absent for app-made turns. */
  turnOf?: string
  /** What the reply cost (its model calls), kept on the reply's row (metadata.usage). */
  usage?: ReplyCost
}): Promise<{ messageId: string; storedStepCount: number }> {
  const storedSteps = compactChatIntermediateSteps(input.intermediateSteps)
  const turnOf = input.turnOf ? { turnOf: input.turnOf } : null
  const replyMetadata = turnOf || input.usage ? { ...turnOf, ...(input.usage ? { usage: input.usage } : {}) } : null
  for (const step of storedSteps) {
    await input.db.insert(chatMessage).values({
      sessionId: input.sessionId,
      userId: input.userId,
      role: 'assistant',
      content: step.content,
      metadata: { ...step.metadata, ...turnOf },
    })
  }
  const messageId = await persistAssistantMessage(
    input.db,
    input.sessionId,
    input.userId,
    input.responseText,
    replyMetadata,
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
  /**
   * Files read at attach time (POST /api/assistant/attachments) sent with a member message:
   * their text goes into the agent's input, their name/kind/size onto the stored turn.
   */
  attachments?: unknown
  /**
   * Edit-and-resend (board a950ef11): the id of the person's latest message in
   * `sessionId`, which this message replaces. The old turn leaves the model's
   * context and the chat (kept as history); then this message runs.
   */
  replacesMessageId?: unknown
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
  /** The stored member message this turn answers (absent for app-made turns). */
  turn: { turnId?: string },
) => Promise<string>

/**
 * Edit-and-resend on the model side: AgentRuntime.supersedeTurn for this
 * endpoint's agent, as `userId`. Refuses with KernelError 'turn_not_editable'.
 */
export type AgentChatSupersede = (
  sessionId: string,
  turnId: string,
  replacementTurnId: string,
  userId: string,
) => Promise<void>

export type HandleAgentChatPostOptions = {
  /** Fixed session mode for this endpoint. */
  sessionMode: ChatSessionMode
  /** The harness dispatch (AgentRuntime.dispatch for the orchestrator agent). */
  dispatch: AgentChatDispatch
  /** Edit-and-resend's model side (AgentRuntime.supersedeTurn for the same agent). */
  supersedeTurn: AgentChatSupersede
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

  if (bootstrap && body.attachments !== undefined) {
    error(400, 'attachments come only with a member message')
  }
  let attachments
  try {
    attachments = parseChatAttachments(body.attachments)
  } catch (err) {
    if (err instanceof AssistantAttachmentError) error(err.status, err.message)
    throw err
  }

  if (!message && !bootstrap && attachments.length === 0) {
    console.error(`[${options.logTag ?? 'api/chat'}] empty message`)
    error(400, 'message is required')
  }

  const sessionKey =
    typeof body.sessionId === 'string' && body.sessionId.trim() ? body.sessionId.trim() : null
  let replacesMessageId: string | null = null
  if (body.replacesMessageId !== undefined) {
    if (typeof body.replacesMessageId !== 'string' || !body.replacesMessageId.trim()) {
      error(400, 'replacesMessageId must name a message')
    }
    if (bootstrap) error(400, 'replacesMessageId comes only with a member message')
    if (!sessionKey) error(400, 'replacesMessageId needs the sessionId of its conversation')
    replacesMessageId = body.replacesMessageId.trim()
  }

  const agentUserMessage = composeAgentMessage(
    options.resolveAgentUserMessage({ bootstrap, message, briefingPeriod }),
    attachments,
  )
  const userMessageMetadata = attachmentMetadata(attachments)

  const db = getDb()
  // Mode mismatch still fails loud (400) inside getOrCreateSession.
  const { sessionId } = await getOrCreateSession(db, user.id, sessionKey, options.sessionMode)

  // The stored member message this turn answers: its id tags the turn on the
  // model side and every row it writes here (edit-and-resend finds it by it).
  const userMessageId = bootstrap ? null : crypto.randomUUID()
  let isFirstMessage: boolean
  if (replacesMessageId && userMessageId) {
    isFirstMessage = (
      await replaceTurn(db, options, {
        sessionId,
        userId: user.id,
        replacesMessageId,
        replacementId: userMessageId,
        content: message,
        metadata: userMessageMetadata ?? null,
      })
    ).isFirst
  } else {
    if (userMessageId) {
      await db.insert(chatMessage).values({
        id: userMessageId,
        sessionId,
        userId: user.id,
        role: 'user',
        content: message,
        ...(userMessageMetadata ? { metadata: userMessageMetadata } : {}),
      })
    }
    const countResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(chatMessage)
      .where(eq(chatMessage.sessionId, sessionId))
    isFirstMessage = bootstrap || countResult[0]?.count === 1
  }
  const turn = userMessageId ? { turnId: userMessageId } : {}

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

    // First line: the stored message and its session, so the surface can name
    // the message (edit it) even when the person stops before the reply.
    if (userMessageId) writeLine({ type: 'turn.accepted', sessionId, messageId: userMessageId })

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
      stepId?: string
      resultSummary?: string | null
    }) => {
      if (evt.type === 'thinking' && evt.content) {
        intermediateSteps.push({
          content: evt.content,
          metadata: { variant: 'thinking' },
        })
      } else if (evt.type === 'tool.preview') {
        intermediateSteps.push({
          content: evt.inputSummary ?? '',
          metadata: {
            variant: 'tool_preview',
            tool: evt.tool,
            ...(evt.stepId ? { stepId: evt.stepId, status: 'running' } : {}),
          },
        })
      } else if (evt.type === 'tool.finished') {
        // One stored row per tool step: the finish lands on its preview's row.
        const step = intermediateSteps.find(
          (s) => s.metadata.variant === 'tool_preview' && s.metadata.stepId === evt.stepId,
        )
        if (!step) {
          // The engine's sinks swallow throws (best-effort channel), so say it in the log.
          console.error(`[${options.logTag ?? 'api/chat'}] tool.finished without its tool.preview`, {
            stepId: evt.stepId,
            tool: evt.tool,
          })
          return
        }
        step.metadata.status = evt.failed ? 'failed' : 'done'
        step.metadata.resultSummary = evt.resultSummary ?? null
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

    const requestAiCtx = requestAiContextAsyncLocal.getStore()
    const chatWork = (async () => {
      let reserved: Awaited<ReturnType<typeof appSql.reserve>> | null = null
      try {
        reserved = await appSql.reserve()
        await activateTenantDbSession(reserved, user.id)
        const scopedDb = createScopedDrizzle(reserved)

        // One path: the kernel harness. The reply text comes back from the
        // runtime; stream/surface events flow out through the sinks below.
        const runTurn = () =>
          tenantUserAsyncLocal.run(user.id, () =>
            appDbAsyncLocal.run(scopedDb, () =>
              runMeasuredTurn(() =>
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
                }, user.id, turn),
              ),
            ),
          )
        const measured = await (requestAiCtx
          ? requestAiContextAsyncLocal.run(requestAiCtx, runTurn)
          : runTurn())
        const reply = measured.value
        const usage = await readReplyCost(scopedDb, user.id, measured)

        if (reply.trim().length === 0) throw new EmptyReplyError('no_text')
        const responseText = sanitizeFinalAnswerText(reply)
        const { messageId } = await persistStreamedAssistantTurn({
          db: scopedDb,
          sessionId,
          userId: user.id,
          responseText,
          intermediateSteps,
          ...(userMessageId ? { turnOf: userMessageId } : {}),
          usage,
        })
        sendTerminal({
          type: 'done',
          response: responseText,
          sessionId,
          messageId,
          usage,
        })

        if (isFirstMessage && !bootstrap && message.length > 0) {
          const title = message.length > 80 ? message.slice(0, 77) + '...' : message
          await scopedDb.update(chatSession).set({ title }).where(eq(chatSession.id, sessionId))
        }
      } catch (err) {
        if (stoppedByEdit(err)) {
          console.info(`[${options.logTag ?? 'api/chat'}] turn stopped: the person edited it and sent it again`, {
            sessionId,
          })
          sendTerminal({ type: 'error', error: CHAT_TURN_STOPPED_MESSAGE })
        } else {
          await reportTurnFailure(options, { err, sessionId, userId: user.id })
          sendTerminal(chatErrorTerminalPayload(err))
        }
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
    const measured = await runMeasuredTurn(() =>
      options.dispatch(sessionId, agentUserMessage, {
        stream: () => {},
        surfaceEvent: () => {},
      }, user.id, turn),
    )
    const reply = measured.value
    const usage = await readReplyCost(db, user.id, measured)

    if (reply.trim().length === 0) throw new EmptyReplyError('no_text')
    const responseText = sanitizeFinalAnswerText(reply)
    const messageId = await persistAssistantMessage(db, sessionId, user.id, responseText, {
      ...(userMessageId ? { turnOf: userMessageId } : {}),
      usage,
    })

    if (isFirstMessage && !bootstrap && message.length > 0) {
      const title = message.length > 80 ? message.slice(0, 77) + '...' : message
      await db.update(chatSession).set({ title }).where(eq(chatSession.id, sessionId))
    }

    return json({
      response: responseText,
      history: [],
      sessionId,
      messageId,
      usage,
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

/**
 * Edit-and-resend: check the chat side (only the latest live message), take
 * the old turn out of the model's context (stopping it if it still runs),
 * then record the replacement in chat_message. Nothing changes when either
 * check refuses: 409 with fixed words.
 */
async function replaceTurn(
  db: ReturnType<typeof getDb>,
  options: HandleAgentChatPostOptions,
  input: {
    sessionId: string
    userId: string
    replacesMessageId: string
    replacementId: string
    content: string
    metadata: Record<string, unknown> | null
  },
): Promise<EditableTurn> {
  const logTag = options.logTag ?? 'api/chat'
  let editable: EditableTurn
  try {
    editable = await findEditableTurn(db, {
      sessionId: input.sessionId,
      userId: input.userId,
      messageId: input.replacesMessageId,
    })
    await options.supersedeTurn(input.sessionId, input.replacesMessageId, input.replacementId, input.userId)
  } catch (err) {
    const refused =
      err instanceof TurnNotEditableError || (err instanceof KernelError && err.code === 'turn_not_editable')
    if (!refused) throw err
    console.warn(`[${logTag}] edit refused`, { sessionId: input.sessionId, reason: (err as Error).message })
    error(409, TURN_NOT_EDITABLE_MESSAGE)
  }
  await replaceChatTurn(db, input)
  return editable
}
