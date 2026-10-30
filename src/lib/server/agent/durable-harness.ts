import type { DurableConversationIndex } from './conversation-index'
import { mkdirSync, openSync, readFileSync, unlinkSync, writeSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import type {
  BackgroundRunHandle,
  BackgroundRunInput,
  BackgroundToolExecutor,
  DurableBridgeToolSpec,
  DurableEngineConversation,
  DurableEngineHarness,
  DurableToolSurfaceEntry,
  SettledDurableTurn,
} from '$lib/kernel/engines/durable'
import { DurableRunError } from '$lib/kernel/engines/durable'
import { dbScopedGatewayComplete } from './db-scoped-complete'
import {
  createGatewayModelCatalog,
  GATEWAY_MODEL_ID,
  GATEWAY_PROVIDER_ID,
  type GatewayCompleteFn,
} from './gateway-model'
import {
  BACKGROUND_CONTEXT,
  Harness,
  Type,
  createRegistry,
  defineExtension,
  defineTool,
  openNodeSqliteStorage,
  watchEvents,
  type AgentEventStream,
  type Conversation,
  type ConversationId,
  type DurableHarness,
  type SettledSubmissionRecord,
  type ToolRegistration,
} from './pi-durable'

/**
 * The process-wide durable agent harness (plan/phase-durable.md D2/D3):
 * one SQLite file per company, one exclusive owner per file, one harness per
 * process lifetime. Opened lazily on first dispatch — boot never opens it (the
 * health gate stays DB-ping only) — and cached on globalThis so HMR
 * re-compositions reuse the open harness instead of racing for the SQLite
 * lock. There is no graceful-close handler: recovery-on-reopen IS the feature.
 */

/** Tools of one installed kernel bridge extension (replaced in place per dispatch). */
const KERNEL_TOOL_EXTENSION = 'ee-kernel-tools'

const LOCK_POLL_MS = 100
/**
 * Long enough to outlast a blue-green handover: the old slot holds the lock
 * until ee drains it, seconds after the edge switched to the new slot.
 */
const LOCK_RETRY_WINDOW_MS = 30_000

/**
 * Storage dir resolution (D2): EE_AGENT_STATE_DIR if set; else
 * `${EE_STATE_DIR}/agent` when the ee substrate injected EE_STATE_DIR
 * (StateDirectory survives blue-green redeploys; the release tree is
 * read-only); else fail loud — no default location, ever.
 */
export function resolveAgentStateDir(env: Record<string, string | undefined>): string {
  const explicit = env.EE_AGENT_STATE_DIR?.trim()
  if (explicit) return explicit
  const substrate = env.EE_STATE_DIR?.trim()
  if (substrate) return join(substrate, 'agent')
  throw new Error(
    'durable agent storage is not configured: set EE_AGENT_STATE_DIR to a writable directory for agent state, or run under the ee substrate which injects EE_STATE_DIR (state then lives at $EE_STATE_DIR/agent). Refusing to guess — the agent transcript must never land in a default location.',
  )
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export type AgentStateLock = {
  path: string
  pid: number
}

function writeLock(path: string, pid: number): AgentStateLock {
  const fd = openSync(path, 'wx')
  try {
    writeSync(fd, String(pid))
  } finally {
    closeSync(fd)
  }
  return { path, pid }
}

/**
 * Single-owner guard (D3): pi-durable has no cross-process locking — two open
 * harnesses on one SQLite file corrupt each other via id-mint collisions. The
 * host takes a pid-stamped exclusive lockfile first: a live owner fails the
 * acquisition loud after a bounded retry window; a dead owner's lock is stolen.
 */
export async function acquireAgentStateLock(
  dir: string,
  options: { retryWindowMs?: number; pollMs?: number; pid?: number } = {},
): Promise<AgentStateLock> {
  const path = join(dir, 'agent.lock')
  const pid = options.pid ?? process.pid
  const deadline = Date.now() + (options.retryWindowMs ?? LOCK_RETRY_WINDOW_MS)
  const pollMs = options.pollMs ?? LOCK_POLL_MS

  for (;;) {
    try {
      return writeLock(path, pid)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }

    let ownerPid: number | undefined
    try {
      const raw = readFileSync(path, 'utf-8').trim()
      ownerPid = /^\d+$/.test(raw) ? Number(raw) : undefined
    } catch {
      ownerPid = undefined
    }

    if (ownerPid === pid) {
      // Our own stamp (a previous open in this process failed after locking): reuse it.
      return { path, pid }
    }

    if (ownerPid !== undefined && isPidAlive(ownerPid)) {
      if (Date.now() >= deadline) {
        throw new Error(
          `durable agent state is owned by pid ${ownerPid} (lock file ${path}): another live process is running the durable harness over this state directory. Stop that process first — never delete the lock while its owner is alive.`,
        )
      }
      // Async wait: a blocking wait here would freeze every request on this server.
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))))
      continue
    }

    // Dead owner (or unreadable/garbage stamp): steal the lock, loudly marked.
    console.warn(
      `[durable] stealing stale agent lock at ${path}${ownerPid === undefined ? ' (unreadable pid stamp)' : ` (owner pid ${ownerPid} is dead)`}`,
    )
    unlinkSync(path)
  }
}

export function releaseAgentStateLock(lock: AgentStateLock): void {
  try {
    const raw = readFileSync(lock.path, 'utf-8').trim()
    if (raw === String(lock.pid)) unlinkSync(lock.path)
  } catch {
    // already gone
  }
}

export type DurableHarnessDeps = {
  /**
   * Composition-root env (boot convention: injectable, defaults to
   * process.env). Read ONCE here for the storage dir — the harness is a
   * process-lifetime singleton.
   */
  env: Record<string, string | undefined>
  /** The Postgres conversation index (D7) — attribution + conversation lookup. */
  index: DurableConversationIndex
  /** Overrides the gateway completion call (tests inject fakes; never a real LLM). */
  complete?: GatewayCompleteFn
  /** Failure reporter (default: console.error with the [durable] prefix). */
  onReport?: (error: unknown) => void
  /**
   * Executes a BACKGROUND run's tool call as its recorded principal (kernel
   * registry: permission / approval / audit). Required — background runs have
   * no live request to borrow a principal from.
   */
  runAsPrincipal: BackgroundToolExecutor
  /**
   * D9: a CHAT turn that settled with no live request (it was resumed after a
   * restart) hands its reply here so the chat bubble appears. Must be
   * idempotent on `answerKey`.
   */
  mirrorResumedChatTurn: (turn: ResumedChatTurn) => Promise<void>
}

/** A chat turn that settled after a restart, with nobody waiting for it (D9). */
export type ResumedChatTurn = {
  conversationKey: string
  agentId: string
  /** The chat's human (the gateway billing identity of the conversation). */
  llmUserId: string
  piConversationId: string
  /** `<piConversationId>:<answerEntryId>` — stable idempotency key of the reply. */
  answerKey: string
  reply: string
}

export type DurableHarnessBox = {
  /** The open pi-durable harness (typed; keep pi-durable types in this module). */
  harness: DurableHarness
  /** The Postgres conversation index this harness attributes through. */
  index: DurableConversationIndex
  /** Resolved storage directory (for ops/health surfaces). */
  readonly stateDir: string
  /** Live event stream of one conversation (the D8 multiplayer slice). */
  events(conversationId: number): Promise<AgentEventStream>
  /** The engine-facing port: one conversation per (agentId, sessionId), plus background runs. */
  readonly engineHarness: DurableEngineHarness
  /** Wait for one submission (e.g. a background run's prompt) to settle. */
  waitForSubmission(submissionId: string): Promise<SettledDurableTurn>
}

async function openDurableHarness(deps: DurableHarnessDeps): Promise<DurableHarnessBox> {
  const stateDir = resolveAgentStateDir(deps.env)
  mkdirSync(stateDir, { recursive: true })
  const lock = await acquireAgentStateLock(stateDir)
  try {
    return await openLocked(deps, stateDir)
  } catch (err) {
    releaseAgentStateLock(lock)
    throw err
  }
}

async function openLocked(deps: DurableHarnessDeps, stateDir: string): Promise<DurableHarnessBox> {
  const storage = await openNodeSqliteStorage(join(stateDir, 'agent.sqlite'), { prefix: 'pi_' })

  const index = deps.index
  const models = createGatewayModelCatalog({
    complete: deps.complete ?? dbScopedGatewayComplete,
    resolveUserId: async (providerSessionId) => {
      const row = await index.resolveByProviderSession(providerSessionId)
      if (!row) {
        throw new Error(
          `no durable conversation is indexed for provider session ${providerSessionId} — refusing an anonymous model call (the conversation index is the billing attribution source)`,
        )
      }
      return row.llmUserId
    },
  })

  const registry = createRegistry()
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      onReport:
        deps.onReport ??
        ((error: unknown) => {
          console.error('[durable] report:', error)
        }),
    },
    BACKGROUND_CONTEXT,
  )
  // harness.resume() runs at the END of this function: the tool bridge of
  // every background run and the resumed-turn watchers must exist first.

  // pi-durable ids are branded safe integers — String() and Number() round-trip.
  function asConversationId(id: number | string): ConversationId {
    return Number(id) as unknown as ConversationId
  }

  /**
   * Install (or replace in place) the kernel tool bridge extension from this
   * dispatch's surface, and return the registrations to configure the
   * conversation with. Args are validated against the kernel tool's JSON
   * Schema (zod v4 output, wrapped as a TypeBox schema); the model-visible
   * result text matches what durable feeds.
   */
  /**
   * Conversation-scoped tool routing. The registry holds ONE kernel bridge
   * extension with every tool name any dispatch has offered (it only grows), and
   * each conversation is configured with exactly its own dispatch's fail-closed
   * subset. A call executes through the bridge of the dispatch that currently
   * owns ITS conversation (api.conversationId) — never through another user's
   * closures. A call with no live dispatch (resumed after a restart) does not
   * run: there is no principal to run it as, so it reports that instead.
   */
  const activeBridges = new Map<string, Map<string, DurableBridgeToolSpec>>()
  const knownTools = new Map<string, DurableToolSurfaceEntry>()
  /**
   * Background runs by pi conversation id: their tools execute as the RECORDED
   * principal (index row), live or resumed after a restart — never through a
   * chat request's closures.
   */
  const backgroundRuns = new Map<string, { principalId: string; agentId: string; tools: Set<string> }>()

  function notRun(why: string) {
    return {
      output: [{ type: 'text' as const, text: JSON.stringify({ status: 'not_run', message: why }) }],
      isError: true,
    }
  }

  function bridgeTool(spec: DurableToolSurfaceEntry): ToolRegistration {
    return defineTool({
      name: spec.name,
      description: spec.description,
      parameters: Type.Unsafe<Record<string, unknown>>(spec.parametersJsonSchema),
      execute: async (args, api) => {
        const conversationId = String(api.conversationId)
        const background = backgroundRuns.get(conversationId)
        if (background) {
          if (!background.tools.has(spec.name)) {
            return notRun(`tool ${spec.name} is not in this background run's tool surface`)
          }
          const result = await deps.runAsPrincipal({
            principalId: background.principalId,
            agentId: background.agentId,
            tool: spec.name,
            args: args as Record<string, unknown>,
          })
          return { output: [{ type: 'text', text: JSON.stringify(result ?? null) }] }
        }
        const bridge = activeBridges.get(conversationId)
        const own = bridge?.get(spec.name)
        if (!own) {
          return notRun(
            bridge
              ? `tool ${spec.name} is not available to this conversation's current dispatch`
              : `tool ${spec.name} was interrupted by a server restart and was not run (no live request to run it as) — ask again`,
          )
        }
        const result = await own.execute(args as Record<string, unknown>)
        return { output: [{ type: 'text', text: JSON.stringify(result ?? null) }] }
      },
    })
  }

  function installToolBridge(tools: DurableToolSurfaceEntry[]): ToolRegistration[] {
    let grew = false
    for (const spec of tools) {
      if (!knownTools.has(spec.name)) grew = true
      knownTools.set(spec.name, {
        name: spec.name,
        description: spec.description,
        parametersJsonSchema: spec.parametersJsonSchema,
      })
    }
    const all = [...knownTools.values()].map(bridgeTool)
    if (grew || all.length === 0) {
      registry.install(defineExtension({ name: KERNEL_TOOL_EXTENSION, tools: all }))
    }
    const byName = new Map(all.map((r) => [r.name, r]))
    return tools.map((t) => byName.get(t.name)!)
  }

  function replyOf(conversation: Conversation, answerEntryId: number): Promise<string> {
    return (async () => {
      const page = await conversation.entries(
        {
          minEntryId: answerEntryId as never,
          maxEntryId: answerEntryId as never,
          order: 'ascending',
        },
        1,
        undefined,
        BACKGROUND_CONTEXT,
      )
      const entry = page.items[0]
      if (!entry) {
        throw new Error(
          `durable run settled done but answer entry ${answerEntryId} is missing from storage`,
        )
      }
      const message = entry.model?.[0]
      if (!message || message.role !== 'assistant') {
        throw new Error(`answer entry ${answerEntryId} does not carry an assistant message`)
      }
      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
      if (!text) return 'The assistant did not produce a response.'
      return text
    })()
  }

  async function conversation(input: {
    conversationKey: string
    agentId: string
    llmUserId: string
    instructions: string
    tools: DurableBridgeToolSpec[]
  }): Promise<DurableEngineConversation> {
    // The bridge is refreshed per dispatch: the extension is replaced in place
    // (registry.install), then the conversation is configured with exactly
    // these tools — the model only ever sees the current fail-closed surface.
    const registrations = installToolBridge(input.tools)

    const existing = await index.resolveByConversationKey(input.conversationKey)
    if (existing) {
      const conversation = await harness.conversation(
        asConversationId(existing.piConversationId),
        BACKGROUND_CONTEXT,
      )
      if (!conversation) {
        throw new Error(
          `durable conversation ${existing.piConversationId} (key ${input.conversationKey}) is indexed but missing from storage at ${stateDir} — the agent state directory was replaced without resetting the conversation index`,
        )
      }
      await conversation.configure({ tools: registrations }, BACKGROUND_CONTEXT)
      return engineConversation(conversation, existing.id, input.tools)
    }

    const { conversation, row } = await createIndexedConversation({
      conversationKey: input.conversationKey,
      agentId: input.agentId,
      llmUserId: input.llmUserId,
      instructions: input.instructions,
      registrations,
    })
    return engineConversation(conversation, row.id, input.tools)
  }

  /**
   * Create an ownerless conversation and record its index row. The provider
   * session id is THE crash-safe attribution key (D7): read it from the
   * conversation view and record the index row BEFORE the first submit, so
   * even a crash right after submit bills correctly.
   */
  async function createIndexedConversation(input: {
    conversationKey: string
    agentId: string
    llmUserId: string
    instructions: string
    registrations: ToolRegistration[]
    background?: { principalId: string; tools: DurableToolSurfaceEntry[] }
  }) {
    const conversation = await harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: {
          model: { provider: GATEWAY_PROVIDER_ID, modelId: GATEWAY_MODEL_ID },
          instructions: input.instructions,
          tools: input.registrations,
        },
      },
      BACKGROUND_CONTEXT,
    )
    const view = await conversation.viewState(BACKGROUND_CONTEXT)
    const providerDoc = view.value.docs['pi.provider'] as { sessionId?: unknown } | undefined
    const providerSessionId =
      providerDoc && typeof providerDoc.sessionId === 'string' ? providerDoc.sessionId : undefined
    if (!providerSessionId) {
      throw new Error(
        `freshly created durable conversation ${String(conversation.id)} has no pi.provider sessionId`,
      )
    }
    const row = await index.recordConversation({
      conversationKey: input.conversationKey,
      agentId: input.agentId,
      llmUserId: input.llmUserId,
      piConversationId: String(conversation.id),
      providerSessionId,
      ...(input.background
        ? { runPrincipalId: input.background.principalId, runTools: input.background.tools }
        : {}),
    })
    return { conversation, row }
  }

  function trackBackgroundRun(piConversationId: string, run: { principalId: string; agentId: string; tools: DurableToolSurfaceEntry[] }) {
    backgroundRuns.set(piConversationId, {
      principalId: run.principalId,
      agentId: run.agentId,
      tools: new Set(run.tools.map((t) => t.name)),
    })
  }

  /**
   * Start a background run (plan/phase-software-factory.md §3.1): an ownerless
   * conversation recorded with its run principal + tool surface, its prompt
   * durably admitted. Nobody awaits it — the harness drives it to settle, and
   * a reopened harness resumes it (its tools still run as the recorded principal).
   */
  async function startBackgroundRun(input: BackgroundRunInput): Promise<BackgroundRunHandle> {
    if (await index.resolveByConversationKey(input.conversationKey)) {
      throw new Error(
        `background run key ${input.conversationKey} is already indexed — a background run is started once; pick a new key`,
      )
    }
    const registrations = installToolBridge(input.tools)
    const { conversation, row } = await createIndexedConversation({
      conversationKey: input.conversationKey,
      agentId: input.agentId,
      llmUserId: input.llmUserId,
      instructions: input.instructions,
      registrations,
      background: { principalId: input.principalId, tools: input.tools },
    })
    if (row.piConversationId !== String(conversation.id)) {
      throw new Error(
        `background run key ${input.conversationKey} was recorded concurrently for another conversation (${row.piConversationId})`,
      )
    }
    trackBackgroundRun(row.piConversationId, input)
    const submission = await conversation.submit({ type: 'input', content: input.prompt }, BACKGROUND_CONTEXT)
    return {
      conversationId: row.piConversationId,
      conversationKey: row.conversationKey,
      submissionId: String(submission.id),
    }
  }

  async function settledTurn(conversationId: ConversationId, settled: SettledSubmissionRecord): Promise<SettledDurableTurn> {
    if (settled.status === 'unanswered') {
      return { status: 'unanswered', reason: settled.reason, detail: settled.detail }
    }
    if (settled.type !== 'input') {
      throw new DurableRunError(`submission settled in an unexpected state: ${settled.status}/${settled.type}`)
    }
    const conversation = await harness.conversation(conversationId, BACKGROUND_CONTEXT)
    if (!conversation) throw new Error(`durable conversation ${String(conversationId)} vanished from storage`)
    return { status: 'done', reply: await replyOf(conversation, settled.answer) }
  }

  async function waitForSubmission(submissionId: string): Promise<SettledDurableTurn> {
    const submission = await harness.submission(Number(submissionId) as never, BACKGROUND_CONTEXT)
    if (!submission) throw new Error(`unknown durable submission ${submissionId}`)
    const settled = await submission.wait(BACKGROUND_CONTEXT)
    return settledTurn(settled.conversationId, settled)
  }

  function engineConversation(
    conversation: Conversation,
    indexRowId: number,
    tools: DurableBridgeToolSpec[],
  ): DurableEngineConversation {
    const key = String(conversation.id)
    return {
      id: key,
      submitAndSettle: async (content: string): Promise<SettledDurableTurn> => {
        if (activeBridges.has(key)) {
          throw new DurableRunError('conversation_busy', `durable conversation ${key} already has a turn in flight`)
        }
        activeBridges.set(key, new Map(tools.map((t) => [t.name, t])))
        let settled
        try {
          const submission = await conversation.submit({ type: 'input', content }, BACKGROUND_CONTEXT)
          settled = await submission.wait(BACKGROUND_CONTEXT)
        } finally {
          activeBridges.delete(key)
        }
        await index.touch(indexRowId)
        if (settled.status === 'unanswered') {
          return { status: 'unanswered', reason: settled.reason, detail: settled.detail }
        }
        if (settled.status !== 'done' || settled.type !== 'input') {
          throw new DurableRunError(
            `submission settled in an unexpected state: ${settled.status}/${settled.type}`,
          )
        }
        return { status: 'done', reply: await replyOf(conversation, settled.answer) }
      },
    }
  }

  // Background runs survive restarts: re-register each recorded run's tool
  // surface and principal routing BEFORE resuming, so a resumed tool call
  // executes as its recorded principal instead of reporting not_run.
  for (const row of await index.listConversations()) {
    if (row.runPrincipalId === null) continue
    if (!row.runTools) {
      throw new Error(
        `background run ${row.conversationKey} has run principal ${row.runPrincipalId} but no recorded tool surface`,
      )
    }
    installToolBridge(row.runTools)
    trackBackgroundRun(row.piConversationId, {
      principalId: row.runPrincipalId,
      agentId: row.agentId,
      tools: row.runTools,
    })
  }

  // D9: input submissions still unsettled at open belonged to requests that
  // died with the previous process. Watch each; a CHAT turn that settles done
  // is handed to the chat mirror (nobody else will write its bubble).
  const inspection = await harness.inspect(BACKGROUND_CONTEXT)
  for (const pending of inspection.submissions) {
    if (pending.type !== 'input') continue
    void mirrorWhenSettled(pending.conversationId, String(pending.id)).catch((err: unknown) => {
      ;(deps.onReport ?? ((e: unknown) => console.error('[durable] report:', e)))(
        new Error(`could not mirror resumed submission ${String(pending.id)}`, { cause: err }),
      )
    })
  }

  async function mirrorWhenSettled(conversationId: ConversationId, submissionId: string): Promise<void> {
    const row = await index.resolveByPiConversationId(String(conversationId))
    if (!row) {
      throw new Error(`resumed durable conversation ${String(conversationId)} has no conversation index row`)
    }
    if (row.runPrincipalId !== null) return // background runs have no chat bubble
    const submission = await harness.submission(Number(submissionId) as never, BACKGROUND_CONTEXT)
    if (!submission) throw new Error(`resumed submission ${submissionId} vanished from storage`)
    const settled = await submission.wait(BACKGROUND_CONTEXT)
    if (settled.status !== 'done' || settled.type !== 'input') return // nothing answered to mirror
    const turn = await settledTurn(conversationId, settled)
    if (turn.status !== 'done') return
    await index.touch(row.id)
    await deps.mirrorResumedChatTurn({
      conversationKey: row.conversationKey,
      agentId: row.agentId,
      llmUserId: row.llmUserId,
      piConversationId: row.piConversationId,
      answerKey: `${row.piConversationId}:${String(settled.answer)}`,
      reply: turn.reply,
    })
  }

  harness.resume()

  return {
    harness,
    index,
    stateDir,
    events: (conversationId: number) =>
      watchEvents(harness, asConversationId(conversationId), BACKGROUND_CONTEXT),
    engineHarness: { conversation, startBackgroundRun },
    waitForSubmission,
  }
}

/**
 * globalThis guard (boot.ts recapTickHost pattern): ONE harness per process
 * lifetime, reused across HMR recompositions, never closed on recompose —
 * releasing the SQLite lock would race the next composition.
 */
const durableHost = globalThis as { __eeDurableHarness?: Promise<DurableHarnessBox> }

export function getDurableHarness(deps: DurableHarnessDeps): Promise<DurableHarnessBox> {
  durableHost.__eeDurableHarness ??= openDurableHarness(deps).catch((err: unknown) => {
    // A failed open must not stick: the next call re-attempts a fresh open.
    durableHost.__eeDurableHarness = undefined
    throw err
  })
  return durableHost.__eeDurableHarness
}

/**
 * The harness boot opened, for readers that must never open it themselves
 * (the D8 run view): opening needs the engine's full deps (runAsPrincipal,
 * the chat mirror), which only the composition root has. Not opened yet ⇒
 * fail loud instead of opening a second, under-wired singleton.
 */
export function openedDurableHarness(): Promise<DurableHarnessBox> {
  const opened = durableHost.__eeDurableHarness
  if (!opened) {
    throw new Error('the durable agent harness is not open yet (boot opens it); retry once the server has booted')
  }
  return opened
}

/** Test/ops reset of the process singleton (the opener itself is never cached). */
export function resetDurableHarnessSingletonForTests(): void {
  delete durableHost.__eeDurableHarness
}
