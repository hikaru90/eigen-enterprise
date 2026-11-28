import type { MemoryWriter } from './assistant-writes'
import { KernelError } from '$lib/kernel/errors'
import { defineDecisionKind } from '$lib/server/decisions/kind'

/**
 * The one door, M1 (plan/concept-memory-one-door.md §2.1; Contribute 11f05e24 part 2): what
 * someone types or says into the Ask bar is routed by Jev, not by the chat model. "Is this a
 * question, something to remember, a task, a document or a reminder?" is a closed set, so it is
 * a decision kind (plan/phase-company-brain.md §5). The LLM only writes where text is needed —
 * the chat reply to a question, a reminder's time — and the capture pipeline's enrichment.
 *
 * - `remember`, `task`, `document` are filed straight away, with no chat turn.
 * - `question` opens the chat. `reminder` opens the chat too: its time has to be written out of
 *   the words (the assistant's reminders.create), and that is the LLM's job.
 * - `status_update` (concept §2.3) waits for M3, the Status pages: there is nothing to file it in.
 *
 * Enforced from the start: there is no current judge to shadow (today the chat model picks a
 * tool as part of its reply, not as a separate answer). Low confidence asks instead of guessing,
 * but inline — the Ask bar's chip shows the choices (ROUTE_ASK_BELOW) — not as a Needs-you
 * question, so the kind's own threshold is 0. A person's choice ("change", or a pick when
 * unsure) is the label of the decision it corrects (decisions log, agreement in decisions.kinds).
 * Any Jev failure fails loud: nothing is filed, and the bar says so.
 */

export const INPUT_ROUTES = ['question', 'remember', 'task', 'document', 'reminder'] as const
export type InputRoute = (typeof INPUT_ROUTES)[number]
/** Routes that are filed in Memory without a chat turn. */
export const FILED_ROUTES = ['remember', 'task', 'document'] as const
export type FiledRoute = (typeof FILED_ROUTES)[number]

/** Below this, the bar asks the person which it is instead of filing a guess. */
export const ROUTE_ASK_BELOW = 0.6
export const INPUT_ROUTE_TEXT_MAX = 8_000
const STATE_CHARS = 4_000

export type InputRouteInput = { userId: string; text: string }

const clip = (s: string) => (s.length > STATE_CHARS ? `${s.slice(0, STATE_CHARS)}\n…(truncated)` : s)

export const memoryInputRoute = defineDecisionKind<InputRouteInput, InputRoute>({
  id: 'memory.input_route',
  module: 'memory',
  title: 'What is this input to the company brain?',
  instructions:
    'A member typed or said this into the company brain’s one input. What is it: a question they want answered now, something for the brain to remember, a task to do, a document to keep as written, or a reminder at a time?',
  choices: INPUT_ROUTES,
  criteria: {
    question: 'It asks something and expects an answer now — a question, or a request to look up, explain, summarise, draft or do something in the chat.',
    remember: 'It states a fact, an observation, an idea or a note to keep in mind — information, not something to do — and it is short.',
    task: 'It names one step someone is to do — an action to take, with or without a due day — and no exact time to be reminded at.',
    document: 'It is a longer text to keep as written — several paragraphs, a list, minutes, a draft, a template — not a single fact or step.',
    reminder: 'It asks to be reminded or notified at a time or date ("remind me", "at 3pm", "tomorrow morning ping me").',
  },
  status: 'enforced',
  lowConfidence: 0,
  state: (i) => ['# Input', clip(i.text)].join('\n'),
  // The input is the person's private Memory: the log keeps only its length.
  logInput: (i) => ({ textChars: i.text.length }),
})

export type RouteJev = { decisionId: string; choice: InputRoute; confidence: number; distribution: Record<string, number> }

export type RouteDeps = {
  /** Jev through decide() (enforced): its answer, or a throw. */
  decide(input: InputRouteInput): Promise<RouteJev>
  /** The person's choice as the label of the decision it corrects. */
  label(decisionId: string, choice: InputRoute, userId: string): Promise<void>
  file(route: FiledRoute, userId: string, text: string, via: MemoryWriter['kind']): Promise<{ id: string; url: string }>
  /** Removes what this door filed before (change). */
  unfile(route: FiledRoute, userId: string, id: string): Promise<void>
}

export type RouteRequest = {
  text: string
  /** The person's choice: Jev is not asked. */
  as?: InputRoute
  /** The decision the person's choice corrects (logged as its label). */
  decision_id?: string
  /** What the door filed before for this input, removed after the new filing (change). */
  replaces?: { route: FiledRoute; id: string }
}

type Source = 'jev' | 'person'
export type RouteResult =
  | { outcome: 'filed'; route: FiledRoute; id: string; url: string; decisionId: string | null; confidence: number | null; source: Source }
  | { outcome: 'chat'; route: 'question' | 'reminder'; decisionId: string | null; confidence: number | null; source: Source }
  | { outcome: 'unsure'; decisionId: string; choices: InputRoute[] }

const isFiled = (r: InputRoute): r is FiledRoute => (FILED_ROUTES as readonly string[]).includes(r)

/** The choices, most likely first (by Jev's distribution), then the rest in the kind's order. */
function ranked(distribution: Record<string, number>): InputRoute[] {
  const p = (r: InputRoute) => distribution[r] ?? 0
  return [...INPUT_ROUTES].sort((a, b) => p(b) - p(a) || INPUT_ROUTES.indexOf(a) - INPUT_ROUTES.indexOf(b))
}

export async function routeInput(deps: RouteDeps, writer: MemoryWriter, req: RouteRequest): Promise<RouteResult> {
  const text = req.text.trim()
  if (!text) throw new KernelError('invalid_input', 'Say or type something for the brain.')
  if (text.length > INPUT_ROUTE_TEXT_MAX) throw new KernelError('invalid_input', `Keep it under ${INPUT_ROUTE_TEXT_MAX} characters.`)
  if (req.replaces && !req.as) throw new KernelError('invalid_input', 'Changing what was filed needs the choice to file it as (as).')

  let route: InputRoute
  let decisionId: string | null = req.decision_id ?? null
  let confidence: number | null = null
  let source: Source
  if (req.as) {
    route = req.as
    source = 'person'
    if (decisionId) await deps.label(decisionId, route, writer.userId)
  } else {
    const jev = await deps.decide({ userId: writer.userId, text })
    if (jev.confidence < ROUTE_ASK_BELOW) return { outcome: 'unsure', decisionId: jev.decisionId, choices: ranked(jev.distribution) }
    route = jev.choice
    decisionId = jev.decisionId
    confidence = jev.confidence
    source = 'jev'
  }

  if (!isFiled(route)) {
    if (req.replaces) await deps.unfile(req.replaces.route, writer.userId, req.replaces.id)
    return { outcome: 'chat', route, decisionId, confidence, source }
  }
  const filed = await deps.file(route, writer.userId, text, writer.kind)
  if (req.replaces) await deps.unfile(req.replaces.route, writer.userId, req.replaces.id)
  return { outcome: 'filed', route, id: filed.id, url: filed.url, decisionId, confidence, source }
}
