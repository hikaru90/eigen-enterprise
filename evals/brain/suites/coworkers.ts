import { listSources } from '../fixture/audience'
import { COWORKER_KEYS, MEMBER_KEYS, type CompanyFixture, type CoworkerKey, type SeatKey } from '../types'

/**
 * The co-workers suite (plan/phase-ai-coworkers.md §1, milestone C8): the
 * feature's three promises, each graded without reading meaning from text.
 *
 * - Keeps: a co-worker sits like a new member — what is shared with the
 *   company or with it, never anyone's private items — through every hand its
 *   turn has (the tools it is offered, the `ee` tool, retrieval). Graded on
 *   markers in the tool-level crawl (no model). And its own thoughts are
 *   company-visible, read-only to the people.
 * - Does: a person asks Marketing in #launch, Marketing pulls in GTM and the
 *   Designer, the person gets the answer. Scripted model (the mock gateway's
 *   role), graded on the state it leaves: posts, runs, model requests, costs,
 *   thoughts, the thread budget.
 * - Different: the same open question to the three gives distinct answers —
 *   measured with the embedding model (vectors are its job), real models only.
 */

/** Keeps: no co-worker reaches any of `protects` (none is theirs to read). */
export type CoworkerLeakItem = { id: string; concept: string; protects: string[] }

/** Reach: each of `seats` reaches each of `sources` (what is shared with them must not be lost either). */
export type CoworkerReachItem = { id: string; concept: string; seats: SeatKey[]; sources: string[] }

export const COWORKER_LEAKS: CoworkerLeakItem[] = [
  { id: 'CK01', concept: 'thought-privacy', protects: ['th-martin-lease', 'th-priya-brightwave', 'th-priya-sprint'] },
  { id: 'CK02', concept: 'dm-privacy', protects: ['msg-dm-mo-1', 'msg-dm-mo-2', 'msg-dm-pj-1', 'msg-dm-pj-2'] },
  { id: 'CK03', concept: 'personal-mailbox', protects: ['mail-ony-recruiter'] },
  { id: 'CK04', concept: 'mailbox-audience', protects: ['mail-acme-1'] },
  { id: 'CK05', concept: 'drive-private', protects: ['drive-ony-salary', 'drive-priya-onboarding'] },
  { id: 'CK06', concept: 'drive-shared-with-some', protects: ['drive-acme-proposal'] },
  { id: 'CK07', concept: 'private-channel', protects: ['msg-sales-acme'] },
  { id: 'CK08', concept: 'call-audience', protects: ['call-acme'] },
  { id: 'CK09', concept: 'calendar-private', protects: ['ev-jonas-dentist'] },
  { id: 'CK10', concept: 'contact-private', protects: ['ct-elin'] },
]

const COWORKER_THOUGHTS = ['th-mkt-story', 'th-mkt-channels', 'th-gtm-segment', 'th-gtm-pipeline', 'th-dsg-page', 'th-dsg-a11y']

export const COWORKER_REACH: CoworkerReachItem[] = [
  { id: 'CR01', concept: 'shared-with-the-seat', seats: [...COWORKER_KEYS], sources: ['msg-launch-brief', 'msg-general-brand', 'drive-handbook', 'drive-brand'] },
  { id: 'CR02', concept: 'coworker-thoughts-company-visible', seats: [...MEMBER_KEYS, ...COWORKER_KEYS], sources: COWORKER_THOUGHTS },
]

/** The one co-worker thought the read-only check tries to change, as each person. */
export const READ_ONLY_PROBE = 'th-mkt-story'

/** Does: the launch task. `X` is the product being launched. */
export const DOES_LAUNCH = { asker: 'priya' as const, channelId: 'ch-launch', product: 'Fjordlight Flows' }
/** Does: the forced ping-pong between these two, which the thread budget must stop. */
export const DOES_PING_PONG = { asker: 'priya' as const, channelId: 'ch-launch', between: ['marketing', 'gtm'] as [CoworkerKey, CoworkerKey] }
/** The thread budget the plan promises (§6: 8 co-worker turns without a person). */
export const PROMISED_THREAD_BUDGET = 8

/** Different: asked of each co-worker in its own DM by `asker`. */
export const DIFFERENT_QUESTION = { asker: 'martin' as const, text: 'What should our launch message focus on?' }

/** Each item tests what it claims against the fixture's ground truth. */
export function validateCoworkerSuite(f: CompanyFixture): string[] {
  const errors: string[] = []
  const sources = new Map(listSources(f).map((s) => [s.id, s]))
  const seen = new Set<string>()
  const coworkers = f.coworkers.map((c) => c.key)
  for (const item of [...COWORKER_LEAKS, ...COWORKER_REACH]) {
    if (seen.has(item.id)) errors.push(`duplicate item id ${item.id}`)
    seen.add(item.id)
  }
  for (const item of COWORKER_LEAKS) {
    for (const id of item.protects) {
      const s = sources.get(id)
      if (!s) errors.push(`${item.id}: unknown source ${id}`)
      else for (const c of coworkers) if (s.audience.has(c)) errors.push(`${item.id}: ${c} may read ${id}, so it is no leak test for it`)
    }
  }
  for (const item of COWORKER_REACH) {
    for (const id of item.sources) {
      const s = sources.get(id)
      if (!s) errors.push(`${item.id}: unknown source ${id}`)
      else for (const seat of item.seats) if (!s.audience.has(seat)) errors.push(`${item.id}: ${seat} may not read ${id}`)
    }
  }
  const probe = f.thoughts.find((t) => t.id === READ_ONLY_PROBE)
  if (!probe || !coworkers.includes(probe.owner as CoworkerKey)) errors.push(`${READ_ONLY_PROBE}: the read-only probe is a co-worker's thought`)
  for (const task of [DOES_LAUNCH, DOES_PING_PONG]) {
    const ch = f.channels.find((c) => c.id === task.channelId)
    if (!ch) errors.push(`does: unknown channel ${task.channelId}`)
    else if (ch.private && !ch.members?.includes(task.asker)) errors.push(`does: ${task.asker} is not in ${task.channelId}`)
    else for (const c of coworkers) if (ch.private && !ch.members?.includes(c)) errors.push(`does: co-worker ${c} is not in ${task.channelId}`)
  }
  if (coworkers.length !== 3 || !(['marketing', 'gtm', 'designer'] as const).every((k) => coworkers.includes(k))) {
    errors.push('the co-workers suite needs marketing, gtm and designer')
  }
  return errors
}
