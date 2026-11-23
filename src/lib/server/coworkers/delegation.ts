/**
 * Co-worker → co-worker task chains (plan/phase-ai-coworkers.md §6). A co-worker
 * may hand work to another co-worker with tasks.assign; every run records the
 * co-workers that handed its work down (coworker_run.delegation_chain, origin
 * person excluded). A hand-off is refused BEFORE the task exists when the chain
 * would pass MAX_DELEGATION_HOPS co-workers or hand work back to a co-worker
 * already in it. The assigning co-worker gets the refusal as a tool error and
 * tells its accountable human; nothing stops silently. Structure, no model.
 */

/** Co-workers in one chain of hand-offs from a person's request (person → A → B → C). */
export const MAX_DELEGATION_HOPS = 3

export class CoworkerDelegationError extends Error {
  constructor(
    readonly reason: 'depth' | 'cycle',
    message: string,
  ) {
    super(message)
    this.name = 'CoworkerDelegationError'
  }
}

export type DelegationInput = {
  assigner: { id: string; kind: 'human' | 'coworker' }
  assigneeId: string
  /** The delegation chains of the assigner's running runs (a co-worker assigns from inside one). */
  assignerRunChains: readonly (readonly string[])[]
}

/** The chain a co-worker's assignment run carries; throws CoworkerDelegationError when the hand-off is refused. */
export function nextDelegationChain(i: DelegationInput): string[] {
  if (i.assigner.kind === 'human') return []
  if (i.assignerRunChains.length === 0) {
    throw new Error(`co-worker ${i.assigner.id} assigned a task with no running turn; a co-worker only acts inside a run`)
  }
  const parent = i.assignerRunChains.reduce((a, b) => (b.length > a.length ? b : a))
  const chain = [...parent, i.assigner.id]
  if (chain.includes(i.assigneeId)) {
    throw new CoworkerDelegationError(
      'cycle',
      'That co-worker already handed this work down the chain; handing it back would loop. Finish your part and answer whoever asked you, or ask your accountable human.',
    )
  }
  if (chain.length > MAX_DELEGATION_HOPS) {
    throw new CoworkerDelegationError(
      'depth',
      `This work has already passed ${MAX_DELEGATION_HOPS} co-workers since a person asked for it; it can't be handed on further. Do it yourself or ask your accountable human.`,
    )
  }
  return chain
}
