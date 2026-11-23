import type { MessageDto, MessagesDeps } from '../../../../modules/messages/service'
import type { Conversation, Person } from '../../../../modules/messages/store'
import type { CoworkerView, OrgChartEntry } from './service'
import type { CoworkerRunPatch, CoworkerRunRow, CoworkerRunStore, ThreadKey } from './run-store'
import { KernelError } from '$lib/kernel/errors'
import type { CoworkerStopReason } from '$lib/server/db/coworkers.schema'
import { primaryHandle } from '../../../../modules/messages/notify'
import { canUse, listMessages, listThread } from '../../../../modules/messages/service'
import { assembleCoworkerPrompt, coworkerTurnInput, type CoworkerPromptInput, type PromptPerson } from './prompt'
import { decideClaim } from './run-store'
import { coworkerSessionId, coworkerTriggerFor, threadRootOf } from './triggers'

/**
 * The co-worker turn in Messages (plan/phase-ai-coworkers.md §5, §6, C3).
 *
 * A message that asks a co-worker for a turn (triggers.ts) queues exactly one
 * turn for it — once per (co-worker, message), whichever app process hears it
 * first (coworker_run's unique index). The thread is then drained: its turns
 * for that co-worker are claimed one at a time, oldest trigger first, under the
 * thread's lock (run-store.ts decideClaim). A claimed turn:
 *
 *   1. reloads the co-workers into the runtime (its model and cap as stored now);
 *   2. assembles its prompt (prompt.ts) from the role card, the org chart, the
 *      company, the thread as the co-worker may read it, and the trigger;
 *   3. runs as the co-worker itself (runtime.dispatchAsAgent: its principal,
 *      its model, billed to its user id) inside a trace named by the run id, so
 *      the cost log's rows of this turn are exactly the turn's cost;
 *   4. posts the answer as the co-worker in the same thread.
 *
 * Its @mentions trigger the next co-worker (step 1 again): that is the
 * collaboration. Budgets never stop silently: a thread allows THREAD_TURN_BUDGET
 * co-worker turns without a person's message in between; the daily cap refuses
 * (budget_exceeded); a model failure fails the turn. Each posts a short note as
 * the co-worker saying where things stand and @mentions its accountable human,
 * and marks the run stopped/failed with the error. Nothing is retried.
 */

export const THREAD_TURN_BUDGET = 8
export const TRANSCRIPT_LIMIT = 30
export const HEARTBEAT_MS = 30_000
/** A running turn whose heartbeat is older than this lost its process. */
export const STALE_AFTER_MS = 120_000

export type CompanyContext = { name: string | null; profile: string | null; brandVoice: string | null }

export type CoworkerDirectory = {
  get(userId: string): Promise<CoworkerView>
  orgChart(): Promise<{ people: OrgChartEntry[] }>
}

/** The runtime as the turns use it. */
export type CoworkerAgents = {
  /** Re-reads the enabled co-workers into the runtime (model, cap, prompt function). */
  reload(): Promise<void>
  dispatch(agentId: string, sessionId: string, input: string, options: { requestedBy?: string; turnId: string }): Promise<string>
}

/** The assembled prompt of each running turn, by session, for the agent's `instructions` function. */
export class TurnPrompts {
  private readonly bySession = new Map<string, string>()

  set(sessionId: string, text: string): void {
    if (this.bySession.has(sessionId)) throw new Error(`a co-worker turn is already running in session ${sessionId}`)
    this.bySession.set(sessionId, text)
  }

  get(sessionId: string): string {
    const text = this.bySession.get(sessionId)
    if (text === undefined) {
      throw new Error(`no co-worker turn is running in session ${sessionId}: a co-worker runs only through its turns ($lib/server/coworkers/turns.ts)`)
    }
    return text
  }

  delete(sessionId: string): void {
    this.bySession.delete(sessionId)
  }
}

export type CoworkerTurnsDeps = {
  runs: CoworkerRunStore
  messages: MessagesDeps
  coworkers: CoworkerDirectory
  /** The company as the co-worker may read it (name, what it does, brand voice). */
  company: (coworkerId: string) => Promise<CompanyContext>
  agents: CoworkerAgents
  prompts: TurnPrompts
  /** Posts as the co-worker (messages.post through the kernel, as its principal). */
  post(coworkerId: string, input: { conversationId: string; body: string; parentId: string | null }): Promise<{ id: string }>
  /** What one turn's model calls cost (USD): the cost log's rows of the run's trace for that user id. */
  turnCost(coworkerId: string, runId: string): Promise<number>
  /** Runs `fn` in the trace named `runId` (the gateway tags every cost-log row with it). */
  inTrace<T>(runId: string, fn: () => Promise<T>): Promise<T>
  now?: () => Date
  threadTurnBudget?: number
  heartbeatMs?: number
  staleAfterMs?: number
}

export type StopNoteReason = Exclude<CoworkerStopReason, 'unavailable'>

/** The short note a co-worker posts when a turn cannot answer: where things stand, and its accountable human. */
export function stopNote(input: { reason: StopNoteReason; humanHandle: string; budget: number; dailyCapUsd: number; detail?: string }): string {
  const human = `@${input.humanHandle}`
  const detail = input.detail ? ` (${input.detail.replace(/\s+/g, ' ').trim().slice(0, 240)})` : ''
  switch (input.reason) {
    case 'thread_budget':
      return `I'm stopping here: this thread had ${input.budget} AI co-worker turns in a row without a person. ${human}, where should we take it? Reply in this thread and we'll continue.`
    case 'daily_cap':
      return `I've reached my daily AI budget ($${input.dailyCapUsd.toFixed(2)}), so I can't answer this today. ${human}, raise my cap or pick this up tomorrow.`
    case 'model_error':
      return `I couldn't answer this: my model call failed${detail}. ${human}, please take a look; I won't retry on my own.`
    case 'post_error':
      return `I had an answer but couldn't post it here${detail}. ${human}, please take a look; I won't retry on my own.`
    case 'turn_error':
      return `I couldn't work on this${detail}. ${human}, please take a look; I won't retry on my own.`
    case 'interrupted':
      return `My turn here was interrupted (the server restarted while I was working). ${human}, ask me again if you still need an answer.`
  }
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

type ThreadView = { messages: MessageDto[]; hasOlder: boolean; lastHumanAt: Date | null }

/** The message frames a co-worker hears (MessagesHub 'message' frames, action 'created'). */
export type HeardMessage = Pick<MessageDto, 'id' | 'conversationId' | 'authorId' | 'body' | 'parentId' | 'deleted' | 'call' | 'createdAt'>

export class CoworkerTurns {
  private readonly now: () => Date
  private readonly budget: number
  private readonly heartbeatMs: number
  private readonly staleAfterMs: number
  private readonly inFlight = new Set<Promise<void>>()
  private readonly draining = new Map<string, Promise<void>>()
  private readonly again = new Set<string>()
  private stopped = false

  constructor(private readonly deps: CoworkerTurnsDeps) {
    this.now = deps.now ?? (() => new Date())
    this.budget = deps.threadTurnBudget ?? THREAD_TURN_BUDGET
    this.heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS
    this.staleAfterMs = deps.staleAfterMs ?? STALE_AFTER_MS
  }

  /** No new turn is queued or claimed after this; a turn that runs finishes. */
  stop(): void {
    this.stopped = true
  }

  /** Resolves once nothing is queued, claimed or running in this process (specs). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight])
  }

  /** A new message `coworkerId` may see: queues its turn when the message asks for one, then drains the thread. */
  onMessage(coworkerId: string, message: HeardMessage): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return this.track(this.trigger(coworkerId, message))
  }

  /** Drains one thread for one co-worker (also after a restart, for turns queued before it). */
  drain(coworkerId: string, key: ThreadKey): Promise<void> {
    const name = `${coworkerId}|${key.conversationId}|${key.threadRootId ?? 'main'}`
    const running = this.draining.get(name)
    if (running) {
      this.again.add(name)
      return running
    }
    const run = (async () => {
      do {
        this.again.delete(name)
        await this.drainThread(coworkerId, key)
      } while (this.again.has(name) && !this.stopped)
    })().finally(() => this.draining.delete(name))
    this.draining.set(name, run)
    return this.track(run)
  }

  /**
   * Drains every thread with a queued or running turn: at start (turns queued
   * before a restart) and on a sweep, so a turn whose process died is recovered
   * as interrupted once its heartbeat is stale, and what waited behind it runs.
   */
  async resume(): Promise<void> {
    if (this.stopped) return
    const seen = new Set<string>()
    const drains: Promise<void>[] = []
    for (const r of await this.deps.runs.listUnfinished()) {
      if (!r.conversationId) continue
      const name = `${r.coworkerUserId}|${r.conversationId}|${r.threadRootId ?? 'main'}`
      if (seen.has(name)) continue
      seen.add(name)
      drains.push(this.drain(r.coworkerUserId, { conversationId: r.conversationId, threadRootId: r.threadRootId }))
    }
    await Promise.all(drains)
  }

  private track(p: Promise<void>): Promise<void> {
    this.inFlight.add(p)
    void p.finally(() => this.inFlight.delete(p)).catch(() => {})
    return p
  }

  private async trigger(coworkerId: string, m: HeardMessage): Promise<void> {
    const d = this.deps.messages
    const c = await d.store.getConversation(m.conversationId)
    if (!c) return
    const people = await d.directory.listPeople()
    const kind = coworkerTriggerFor({
      coworkerId,
      message: { id: m.id, authorId: m.authorId, body: m.body, parentId: m.parentId, deleted: m.deleted, isCallLine: m.call !== null },
      conversationKind: c.kind,
      people,
    })
    if (!kind) return
    // A member of the conversation: it may post there, like a person (a private channel it is not in does not ask it).
    if (!(await canUse(d, coworkerId, c, 'edit'))) return
    // Switched off or removed in any process since this one loaded it: it does not take turns.
    const view = await this.deps.coworkers.get(coworkerId)
    if (!view.enabled || view.removedAt) return
    const key: ThreadKey = { conversationId: c.id, threadRootId: threadRootOf(m, c.kind) }
    await this.deps.runs.enqueue({
      coworkerUserId: coworkerId,
      triggerKind: kind,
      conversationId: key.conversationId,
      threadRootId: key.threadRootId,
      triggerMessageId: m.id,
      requestedByUserId: m.authorId,
      triggeredAt: new Date(m.createdAt),
    })
    // Every process that heard it drains: the claim decides who runs it (a redelivery finds it queued or running).
    await this.drain(coworkerId, key)
  }

  private async drainThread(coworkerId: string, key: ThreadKey): Promise<void> {
    const d = this.deps.messages
    for (;;) {
      if (this.stopped) return
      const c = await d.store.getConversation(key.conversationId)
      if (!c) return
      let thread: ThreadView | null = null
      let unreadable: string | null = null
      try {
        thread = await this.readThread(coworkerId, c, key.threadRootId)
      } catch (err) {
        unreadable = errorText(err)
      }
      const now = this.now()
      const decision = await this.deps.runs.withThread(key, async (tx) => {
        const decided = decideClaim(await tx.relevant(thread?.lastHumanAt ?? null), {
          coworkerUserId: coworkerId,
          now,
          staleBefore: new Date(now.getTime() - this.staleAfterMs),
          lastHumanAt: thread?.lastHumanAt ?? null,
          budget: this.budget,
        })
        for (const r of decided.interrupted) {
          await tx.update(r.id, { status: 'failed', stopReason: 'interrupted', endedAt: now, error: 'the turn stopped beating: its server process ended during the turn' })
        }
        const next = decided.next
        if ((next.kind === 'claim' || next.kind === 'over_budget') && unreadable !== null) {
          // It can no longer read the thread (it left the channel, the thread was deleted): nothing to answer in.
          await tx.update(next.run.id, { status: 'failed', stopReason: 'turn_error', startedAt: now, endedAt: now, error: `the thread could not be read: ${unreadable}` })
        } else if (next.kind === 'over_budget') {
          await tx.update(next.run.id, {
            status: 'stopped',
            stopReason: 'thread_budget',
            endedAt: now,
            error: `the thread had ${next.turnsUsed} co-worker turns without a person's message (budget ${this.budget})`,
          })
        } else if (next.kind === 'claim') {
          await tx.update(next.run.id, { status: 'running', startedAt: now, heartbeatAt: now })
        }
        return decided
      })
      for (const r of decision.interrupted) await this.postNote(r, 'interrupted')
      const next = decision.next
      if (next.kind === 'busy' || next.kind === 'empty') return
      if (unreadable !== null || thread === null) continue
      if (next.kind === 'over_budget') {
        if (!next.noteAlreadyPosted) await this.postNote(next.run, 'thread_budget')
        continue
      }
      await this.runTurn(next.run, c, thread, next.turnsUsed)
    }
  }

  /** The thread as the co-worker may read it: a channel thread or DM thread (root + replies), or a DM's main log. */
  private async readThread(coworkerId: string, c: Conversation, threadRootId: string | null): Promise<ThreadView> {
    const d = this.deps.messages
    const people = new Map((await d.directory.listPeople()).map((p) => [p.id, p]))
    let all: MessageDto[]
    let shown: MessageDto[]
    let hasOlder: boolean
    if (threadRootId) {
      const { parent, replies } = await listThread(d, coworkerId, threadRootId)
      all = [parent, ...replies]
      const keep = TRANSCRIPT_LIMIT - 1
      shown = [parent, ...replies.slice(-keep)]
      hasOlder = replies.length > keep
    } else {
      const page = await listMessages(d, coworkerId, c.id, { limit: TRANSCRIPT_LIMIT })
      all = page.messages
      shown = page.messages
      hasOlder = page.hasMore
    }
    let lastHumanAt: Date | null = null
    for (const m of all) {
      if (m.deleted || m.call !== null || people.get(m.authorId)?.kind !== 'human') continue
      const at = new Date(m.createdAt)
      if (!lastHumanAt || at > lastHumanAt) lastHumanAt = at
    }
    return { messages: shown.filter((m) => !m.deleted && m.call === null), hasOlder, lastHumanAt }
  }

  private async runTurn(run: CoworkerRunRow, c: Conversation, thread: ThreadView, turnsUsed: number): Promise<void> {
    const sessionId = coworkerSessionId(run.coworkerUserId, c.id, run.threadRootId)
    const beat = setInterval(() => {
      this.deps.runs.update(run.id, { heartbeatAt: this.now() }).catch((err: unknown) => console.error('[coworkers] turn heartbeat failed', { runId: run.id, err }))
    }, this.heartbeatMs)
    ;(beat as { unref?: () => void }).unref?.()
    let view: CoworkerView | null = null
    let promptSet = false
    try {
      view = await this.deps.coworkers.get(run.coworkerUserId)
      if (!view.enabled || view.removedAt) {
        await this.finish(run, { status: 'stopped', stopReason: 'unavailable', error: 'the co-worker was switched off or removed before this turn ran' })
        return
      }
      await this.deps.agents.reload()
      const prompt = await this.promptInput(run, view, c, thread, turnsUsed)
      this.deps.prompts.set(sessionId, assembleCoworkerPrompt(prompt))
      promptSet = true
      let reply: string
      try {
        reply = await this.deps.inTrace(run.id, () =>
          this.deps.agents.dispatch(view!.agentId, sessionId, coworkerTurnInput(prompt.trigger), {
            ...(run.requestedByUserId ? { requestedBy: run.requestedByUserId } : {}),
            turnId: run.id,
          }),
        )
      } catch (err) {
        const costUsd = await this.deps.turnCost(run.coworkerUserId, run.id)
        const capped = err instanceof KernelError && err.code === 'budget_exceeded'
        const reason: StopNoteReason = capped ? 'daily_cap' : 'model_error'
        await this.finish(run, { status: capped ? 'stopped' : 'failed', stopReason: reason, costUsd, error: errorText(err) })
        await this.postNote(run, reason, capped ? undefined : errorText(err), view)
        return
      }
      const costUsd = await this.deps.turnCost(run.coworkerUserId, run.id)
      if (!reply.trim()) {
        await this.finish(run, { status: 'failed', stopReason: 'model_error', costUsd, error: 'the model answered with no text' })
        await this.postNote(run, 'model_error', 'the model answered with no text', view)
        return
      }
      try {
        await this.deps.post(run.coworkerUserId, { conversationId: c.id, body: reply, parentId: run.threadRootId })
      } catch (err) {
        await this.finish(run, { status: 'failed', stopReason: 'post_error', costUsd, error: errorText(err) })
        await this.postNote(run, 'post_error', errorText(err), view)
        return
      }
      await this.finish(run, { status: 'done', costUsd })
    } catch (err) {
      console.error('[coworkers] a co-worker turn failed', { runId: run.id, err })
      await this.finish(run, { status: 'failed', stopReason: 'turn_error', error: errorText(err) })
      await this.postNote(run, 'turn_error', errorText(err), view ?? undefined)
    } finally {
      clearInterval(beat)
      if (promptSet) this.deps.prompts.delete(sessionId)
    }
  }

  private async finish(run: CoworkerRunRow, patch: CoworkerRunPatch): Promise<void> {
    try {
      await this.deps.runs.update(run.id, { ...patch, endedAt: this.now() })
    } catch (err) {
      // The run stays 'running' and is recovered as interrupted once its heartbeat is stale.
      console.error('[coworkers] recording the end of a co-worker turn failed', { runId: run.id, patch, err })
    }
  }

  /** Posts the stop note as the co-worker in the run's thread, @mentioning its accountable human. A failed note is logged on the run. */
  private async postNote(run: CoworkerRunRow, reason: StopNoteReason, detail?: string, known?: CoworkerView): Promise<void> {
    try {
      if (!run.conversationId) return
      const view = known ?? (await this.deps.coworkers.get(run.coworkerUserId))
      if (!view.accountableHuman) throw new Error(`co-worker ${view.id} has no accountable human (removed)`)
      const human = (await this.deps.messages.directory.listPeople()).find((p) => p.id === view.accountableHuman!.id)
      if (!human) throw new Error(`the accountable human ${view.accountableHuman.id} is not in the people directory`)
      const body = stopNote({ reason, humanHandle: primaryHandle(human), budget: this.budget, dailyCapUsd: view.dailyCapUsd, ...(detail ? { detail } : {}) })
      await this.deps.post(run.coworkerUserId, { conversationId: run.conversationId, body, parentId: run.threadRootId })
    } catch (err) {
      console.error('[coworkers] posting a co-worker stop note failed', { runId: run.id, reason, err })
      await this.deps.runs
        .update(run.id, { error: `${run.error ? `${run.error}; ` : ''}the note could not be posted: ${errorText(err)}` })
        .catch((e: unknown) => console.error('[coworkers] recording a failed stop note failed', { runId: run.id, e }))
    }
  }

  private async promptInput(run: CoworkerRunRow, view: CoworkerView, c: Conversation, thread: ThreadView, turnsUsed: number): Promise<CoworkerPromptInput> {
    const d = this.deps.messages
    const [peopleList, chart, company] = await Promise.all([d.directory.listPeople(), this.deps.coworkers.orgChart(), this.deps.company(view.id)])
    const people = new Map(peopleList.map((p) => [p.id, p]))
    const person = (id: string | null): PromptPerson => {
      const p: Person | undefined = id ? people.get(id) : undefined
      if (!p) return { id: id ?? 'unknown', name: 'Former member', kind: 'human', handle: null }
      if (p.kind === undefined) throw new Error(`the people directory gives no kind (human | coworker) for ${p.id}`)
      return { id: p.id, name: p.name.trim() || p.email, kind: p.kind, handle: primaryHandle(p) }
    }
    const byId = new Map(chart.people.map((e) => [e.id, e]))
    if (!view.accountableHuman) throw new Error(`co-worker ${view.id} has no accountable human (removed)`)
    const manager = view.reportsToUserId ? byId.get(view.reportsToUserId) : undefined
    const triggerMessage = run.triggerMessageId ? await d.store.getMessage(run.triggerMessageId) : null
    const memberIds = c.kind === 'dm' ? await d.store.memberIds(c.id) : []
    return {
      self: {
        id: view.id,
        name: view.name,
        handle: person(view.id).handle ?? view.slug,
        title: view.title,
        accountabilities: view.accountabilities,
        lens: view.lens,
        reportsTo: manager ? { name: manager.name, kind: manager.kind } : null,
        accountableHuman: person(view.accountableHuman.id),
      },
      org: chart.people.map((e) => ({
        ...person(e.id),
        name: e.name,
        kind: e.kind,
        title: e.title,
        accountabilities: e.accountabilities,
        reportsToName: e.reportsToUserId ? (byId.get(e.reportsToUserId)?.name ?? null) : null,
      })),
      company,
      conversation: {
        kind: c.kind,
        title:
          c.kind === 'dm'
            ? memberIds
                .filter((id) => id !== view.id)
                .map((id) => person(id).name)
                .join(', ')
            : `#${c.name}`,
        inThread: run.threadRootId !== null,
      },
      transcript: thread.messages.map((m) => ({ author: person(m.authorId), body: m.body, at: m.createdAt })),
      hasOlder: thread.hasOlder,
      trigger: {
        kind: run.triggerKind,
        from: person(run.requestedByUserId),
        body: triggerMessage && !triggerMessage.deletedAt ? triggerMessage.body : '(the message was deleted)',
      },
      turnsLeft: this.budget - turnsUsed,
    }
  }
}
