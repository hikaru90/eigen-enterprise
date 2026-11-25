import { defineDecisionKind } from '$lib/server/decisions/kind'
import type { HandoverStatus } from '$lib/server/memory/handover/store'

/**
 * Memory's decision kinds (plan/phase-company-brain.md §5, CB2; plan/handover.md).
 *
 * `memory.handover_status`: what a handover entry's status is — a decision is needed, it is in
 * progress, or it is for information. A closed set of three, so a Jev question; the sentence is
 * the LLM's (it only writes). There is no current judge (a new behaviour, the brain's upkeep of
 * a handover), and the entry needs a status to exist, so the kind is ENFORCED from the start: an
 * unsure answer (below `lowConfidence`) is not a guess but a question to the handover's owner in
 * their Needs you; the upkeep call is pending until they answer. The owner changes any status
 * afterwards, and when the owner (or their assistant on their word) gives a status, Jev is not
 * asked at all.
 *
 * Jev reads the topic and the source text the entry is drafted from. The criteria are
 * observations of what the text says is open, never a judgment of the people in it. The log
 * keeps which handover and topic and how long the source was, never the source (it may be a
 * person's private Memory).
 */

export type HandoverStatusInput = {
  handoverId: string
  handoverTitle: string
  /** The owner: the call is billed to them, and they answer when Jev is unsure. */
  ownerId: string
  topic: string
  source: string
}

export const HANDOVER_STATUS_SOURCE_CHARS = 8_000

const clip = (s: string) => (s.length > HANDOVER_STATUS_SOURCE_CHARS ? `${s.slice(0, HANDOVER_STATUS_SOURCE_CHARS)}\n…(truncated)` : s)

export const memoryHandoverStatus = defineDecisionKind<HandoverStatusInput, HandoverStatus>({
  id: 'memory.handover_status',
  module: 'memory',
  title: 'What is the status of this handover entry?',
  instructions:
    'A member keeps a handover page: one entry per topic, so that a colleague taking over knows the current state. From the source below, what is the state of this topic right now for whoever takes it over: does it wait for a decision, is work on it under way, or is it information only?',
  choices: ['decision_needed', 'in_progress', 'for_info'],
  criteria: {
    decision_needed:
      'The source names an open choice, an approval, a yes/no or a sign-off that has not been made yet, and the topic cannot move on until someone makes it.',
    in_progress:
      'The source says work on the topic is under way or scheduled — someone is doing, waiting on or following up something — and no open decision is named.',
    for_info:
      'The source reports something done, settled or merely known — a result, a fact, a closed matter — with nothing left to decide or do.',
  },
  status: 'enforced',
  lowConfidence: 0.6,
  state: (i) => [`Handover: ${i.handoverTitle}`, `Topic: ${i.topic}`, '# Source', clip(i.source)].join('\n'),
  logInput: (i) => ({ handoverId: i.handoverId, topic: i.topic, sourceChars: i.source.length }),
  ask: {
    who: (i) => i.ownerId,
    question: (i) => `Handover "${i.handoverTitle}": what is the status of "${i.topic}"?`,
    labels: { decision_needed: 'Decision needed', in_progress: 'In progress', for_info: 'For info' },
  },
})
