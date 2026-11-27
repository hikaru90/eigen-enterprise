import type { ContactsDeps } from './service'
import type { NextUpCache } from './store'
import { z } from 'zod'
import type { ChatMessage } from '$lib/server/llm/llm-client'
import { askContactsAi, readJson, type ContactsAiCall, type ExtractChat } from './extract'
import { pipeline } from './service'
import {
  NEXT_UP_CANDIDATES_MAX,
  NEXT_UP_KINDS,
  NEXT_UP_MAX,
  NEXT_UP_MIN,
  NEXT_UP_REASON_MAX,
  NEXT_UP_TTL_HOURS,
  STAGE_INFO,
  type NextUp,
  type NextUpKind,
  type PipelineItem,
} from './types'

/**
 * "Next up" (Contribute 057ebd74, Ony: "the AI suggests the next 5–10
 * contacts I should write to or reply to — I don't want to have to think"):
 * the assistant picks, from the person's pipeline (their own and the shared
 * contacts), who to write to or answer next, with a one-line reason each.
 * AGENTS.md: the choice is the AI's (one gateway call, JSON schema, cost
 * tracked as `contacts_next_up`); code here only orders the candidates by
 * their days (to cap what is sent), validates the answer and keeps it.
 *
 * The pick is cached per person (contact_next_up) and reused for
 * NEXT_UP_TTL_HOURS on the day it was made; "Suggest again" asks anew. A
 * contact changed since the pick (logged, moved, edited) has been acted on and
 * drops out of the strip. No AI provider → a plain "unavailable" error, never
 * a list made up here.
 */

export const NEXT_UP_NO_PROVIDER_MESSAGE =
  'The company has no AI provider set up yet, so the assistant can’t suggest who to write to next. The owner sets one up under Settings → AI provider.'

const CALL: ContactsAiCall = {
  task: 'contacts.next_up',
  noProvider: NEXT_UP_NO_PROVIDER_MESSAGE,
  unreadable: (tries, error) => `The assistant’s suggestions couldn’t be read (${tries} tries: ${error}). Try “Suggest again”.`,
}

export type NextUpPorts = { chat: ExtractChat; cache: NextUpCache }

type Suggestion = { contactId: string; kind: NextUpKind; reason: string }

const storedSuggestions = z.array(
  z.object({ contactId: z.string().min(1), kind: z.enum(NEXT_UP_KINDS), reason: z.string().min(1) }).strict(),
)

const answerSchema = z
  .object({
    suggestions: z
      .array(
        z
          .object({
            contact_id: z.string(),
            kind: z.enum(NEXT_UP_KINDS),
            reason: z.string().trim().min(1).max(NEXT_UP_REASON_MAX),
          })
          .strict(),
      )
      .max(NEXT_UP_MAX),
  })
  .strict()

const ANSWER_JSON_SCHEMA = `{
  "suggestions": [
    {
      "contact_id": "<an id from the candidates, exactly>",
      "kind": ${NEXT_UP_KINDS.map((k) => `"${k}"`).join(' | ')},
      "reason": "<one short line, at most ${NEXT_UP_REASON_MAX} characters: why this person, why now>"
    }
  ]
}`

// ── candidates ───────────────────────────────────────────────────────────────

/** The day that makes a contact pressing: since when we wait, else its follow-up / tickler day. */
const dayOf = (i: PipelineItem): string | null => (i.stage === 'waiting' ? i.waitingSince : i.nextFollowUpOn)

/** Closest day first (no day last), then by name — so the cap keeps the most pressing by date. */
function byDay(a: PipelineItem, b: PipelineItem): number {
  const da = dayOf(a)
  const db = dayOf(b)
  if (da !== db) return da === null ? 1 : db === null ? -1 : da.localeCompare(db)
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id)
}

/** What the AI is told about one candidate: the pipeline's own fields, nothing inferred. */
function candidateFacts(i: PipelineItem, userId: string) {
  return {
    id: i.id,
    name: i.name,
    organisation: i.organisation,
    title: i.title,
    list: STAGE_INFO[i.stage].label,
    held_by: i.ownerName,
    held_by_you: i.ownerId === userId,
    via: i.via,
    latest_status: i.latestStatus,
    next_step: i.nextStep,
    next_follow_up_on: i.nextFollowUpOn,
    days_until_follow_up: i.review.daysFromToday,
    waiting_since: i.waitingSince,
    days_waiting: i.review.daysWaiting,
    last_contacted_on: i.lastContactedOn,
    why_relevant: i.whyRelevant,
    tags: i.tags,
    has_email: i.channels.some((c) => c.type === 'email'),
  }
}

export function buildNextUpMessages(input: { today: string; userId: string; candidates: readonly PipelineItem[] }): ChatMessage[] {
  const wanted = Math.min(NEXT_UP_MIN, input.candidates.length)
  const system = [
    'You help a person at a company decide who to write to or reply to next. They keep their contacts in a pipeline worked the Getting Things Done way:',
    `- "${STAGE_INFO.next.label}": the ball is in our court (next_step says what).`,
    `- "${STAGE_INFO.waiting.label}": we wrote and wait on them since waiting_since (days_waiting).`,
    `- "${STAGE_INFO.keep_in_touch.label}": nothing open; check in on next_follow_up_on (the tickler).`,
    `- "${STAGE_INFO.inbox.label}": nobody has written to them yet.`,
    'Pick the contacts this person should write to or answer next, most pressing first, so they don’t have to think about it.',
    'Return JSON only, exactly this schema:',
    ANSWER_JSON_SCHEMA,
    'Rules:',
    `- Between ${wanted} and ${NEXT_UP_MAX} suggestions; each contact at most once; only ids from the candidates, copied exactly.`,
    '- kind: "write" = our move, write to them; "reply" = they wrote or asked and we owe an answer; "chase" = we have waited long enough, nudge them; "check_in" = keep them in the loop, say hello.',
    '- Weigh what is overdue or due today, replies waited on for long, our moves with a concrete next step, contacts held by this person (held_by_you), and why they matter.',
    '- reason: one plain line grounded only in the candidate’s fields (days, next step, latest status, why they matter). Never invent facts. Write it in the language of the contact’s notes; English when there are none.',
  ].join('\n')
  const user = [
    `Today: ${input.today}`,
    'Candidates (JSON):',
    JSON.stringify(input.candidates.map((c) => candidateFacts(c, input.userId))),
  ].join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/** Validates the AI's answer against the schema and the candidates it was given. Throws on anything else. */
export function parseNextUpOutput(response: unknown, candidateIds: readonly string[]): Suggestion[] {
  const out = readJson(response, answerSchema)
  const known = new Set(candidateIds)
  const seen = new Set<string>()
  for (const s of out.suggestions) {
    if (!known.has(s.contact_id)) throw new Error(`contact_id ${s.contact_id} is not one of the candidates`)
    if (seen.has(s.contact_id)) throw new Error(`contact_id ${s.contact_id} is suggested twice`)
    seen.add(s.contact_id)
  }
  const wanted = Math.min(NEXT_UP_MIN, candidateIds.length)
  if (out.suggestions.length < wanted) throw new Error(`${out.suggestions.length} suggestions; at least ${wanted} expected`)
  return out.suggestions.map((s) => ({ contactId: s.contact_id, kind: s.kind, reason: s.reason }))
}

// ── the pick ─────────────────────────────────────────────────────────────────

const TTL_MS = NEXT_UP_TTL_HOURS * 3_600_000

/**
 * The person's "Next up": the cached pick while it is fresh (same day, younger
 * than NEXT_UP_TTL_HOURS), else — or with `refresh` — a new one from the AI.
 * Only people in the company (pipeline() checks).
 */
export async function nextUp(
  d: ContactsDeps,
  ports: NextUpPorts,
  actor: { kind: 'user'; userId: string },
  input: { today: string; refresh?: boolean },
): Promise<NextUp> {
  const p = await pipeline(d, actor, input.today)
  // Personal, like "Follow up next" was: your own and the ones shared with the team or with you, not other people's private ones.
  const visible = p.groups.flatMap((g) => g.items).filter((i) => i.own || i.shared || i.sharedWithViewer)
  const now = d.now?.() ?? new Date()

  const cached = await ports.cache.get(actor.userId)
  const fresh =
    cached !== null && input.refresh !== true && cached.day === p.today && now.getTime() - cached.generatedAt.getTime() < TTL_MS
  let generatedAt: Date
  let suggestions: Suggestion[]
  if (fresh) {
    const stored = storedSuggestions.safeParse(cached.suggestions)
    if (!stored.success) throw new Error(`cached next-up for ${actor.userId} is malformed: ${stored.error.issues[0]?.message}`)
    generatedAt = cached.generatedAt
    suggestions = stored.data
  } else {
    const candidates = [...visible].sort(byDay).slice(0, NEXT_UP_CANDIDATES_MAX)
    suggestions =
      candidates.length === 0
        ? []
        : await askContactsAi(
            ports.chat,
            actor.userId,
            buildNextUpMessages({ today: p.today, userId: actor.userId, candidates }),
            (r) =>
              parseNextUpOutput(
                r,
                candidates.map((c) => c.id),
              ),
            CALL,
          )
    generatedAt = now
    await ports.cache.put({ userId: actor.userId, day: p.today, generatedAt, suggestions })
  }

  const byId = new Map(visible.map((i) => [i.id, i]))
  const items = suggestions.flatMap((s) => {
    const item = byId.get(s.contactId)
    // Gone, no longer yours to see, or changed since the pick (acted on): not suggested any more.
    if (!item || Date.parse(item.updatedAt) > generatedAt.getTime()) return []
    const { review: _review, ...contact } = item
    return [{ contact, kind: s.kind, reason: s.reason }]
  })
  return { generatedAt: generatedAt.toISOString(), items }
}

/** The live ports: the company's AI provider through the gateway, the DB cache. */
export async function liveNextUpPorts(): Promise<NextUpPorts> {
  const [{ liveExtractChat }, { dbNextUpCache }, { appSql, createScopedDrizzle }] = await Promise.all([
    import('./extract'),
    import('./db-store'),
    import('$lib/server/db'),
  ])
  return { chat: liveExtractChat, cache: dbNextUpCache(createScopedDrizzle(appSql)) }
}
