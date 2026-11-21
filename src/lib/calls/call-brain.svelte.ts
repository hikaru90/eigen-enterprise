import type { ActiveCall } from './active-call.svelte'
import type { BrainAnswerDto, BrainClient, CallDto, SharedBrainAnswerDto } from './client'
import type { ShownError } from '$lib/errors/agent-report'
import { shownProblemOf } from './client'

/**
 * The Company Brain in a call, my side (modules/calls/brain.ts): its switch
 * (everyone in the call sees it; on is a member's choice, off anyone's), my
 * "Ask the Brain" question and my answers — mine alone until I share one —
 * and the answers colleagues shared. Nothing here asks the Brain on its own:
 * only ask() does, from my explicit question. Driven by the call view's
 * events; the call's state (listening, shared answers) comes from the call
 * the feed keeps current (ActiveCall), updated at once by my own changes.
 * Members only — a guest's call view has none.
 */

export type BrainCall = Pick<ActiveCall, 'call' | 'update'>

export type CallBrainDeps = {
  active: BrainCall
  /** My user id. */
  me: string
  client: BrainClient
}

export class CallBrain {
  /** My switch while the server has not answered yet. */
  #pending = $state<boolean | null>(null)
  #answers = $state<BrainAnswerDto[]>([])
  #asking = $state(false)
  #problem = $state<ShownError | null>(null)
  readonly #d: CallBrainDeps

  constructor(deps: CallBrainDeps) {
    this.#d = deps
  }

  get #call(): CallDto | null {
    return this.#d.active.call
  }

  /** It is listening to this call (the indicator, the switch). */
  get listening(): boolean {
    return this.#pending ?? this.#call?.brain.listening === true
  }

  /** Who switched it on. */
  get byName(): string | null {
    return this.#call?.brain.byName ?? null
  }

  /** My questions and its answers to me, oldest first. */
  get answers(): BrainAnswerDto[] {
    return this.#answers
  }

  /** What colleagues (and I) shared with the call, oldest first. */
  get shared(): SharedBrainAnswerDto[] {
    return this.#call?.brain.shared ?? []
  }

  get asking(): boolean {
    return this.#asking
  }

  get problem(): ShownError | null {
    return this.#problem
  }

  dismissProblem(): void {
    this.#problem = null
  }

  /** My earlier answers in this call (after a reload). */
  async load(): Promise<void> {
    const call = this.#call
    if (!call) return
    try {
      this.#answers = await this.#d.client.myBrainAnswers(call.id)
    } catch (err) {
      this.#problem = shownProblemOf(err, 'Your earlier answers could not be loaded: ')
    }
  }

  /** The switch: on → it starts listening (everyone sees it); off → it stops. */
  async toggle(): Promise<void> {
    const call = this.#call
    if (!call) return
    const on = !this.listening
    this.#pending = on
    try {
      this.#d.active.update(await this.#d.client.setBrain(call.id, on))
    } catch (err) {
      this.#problem = shownProblemOf(
        err,
        `The Company Brain could not be switched ${on ? 'on' : 'off'}: `,
      )
    } finally {
      this.#pending = null
    }
  }

  /** My question → its answer, to me alone. True when it answered. */
  async ask(question: string): Promise<boolean> {
    const call = this.#call
    const q = question.trim()
    if (!call || q === '' || this.#asking) return false
    this.#asking = true
    this.#problem = null
    try {
      this.#answers = [...this.#answers, await this.#d.client.askBrain(call.id, q)]
      return true
    } catch (err) {
      this.#problem = shownProblemOf(err)
      return false
    } finally {
      this.#asking = false
    }
  }

  /** Share one of my answers with the colleagues in the call. */
  async share(answerId: string): Promise<void> {
    const call = this.#call
    if (!call) return
    try {
      this.#d.active.update(await this.#d.client.shareBrainAnswer(call.id, answerId))
      this.#answers = this.#answers.map((a) => (a.id === answerId ? { ...a, shared: true } : a))
    } catch (err) {
      this.#problem = shownProblemOf(err, 'The answer could not be shared: ')
    }
  }
}
