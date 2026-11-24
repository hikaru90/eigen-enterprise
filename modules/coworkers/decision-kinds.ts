import {
  EVENT_LOG_EXCERPT_CHARS,
  EVENT_STATE_BODY_CHARS,
  type CoworkerEventMineInput,
  type EventMineChoice,
} from '$lib/server/coworkers/events'
import { defineDecisionKind, type DecisionKindDef } from '$lib/server/decisions/kind'

/**
 * The AI co-workers' decision kinds (plan/phase-ai-coworkers.md C7, plan/phase-company-brain.md §5).
 *
 * `coworkers.event_mine`: a company event (a person's channel message) that did not @mention a
 * co-worker — is it that co-worker's to act on? A yes/no question, so Jev; there is no current
 * judge (a new behaviour), so in shadow it is logged and nothing is acted on
 * ($lib/server/coworkers/events.ts).
 *
 * ROUTED ONCE (owner, 2026-11-24): the company's assistant reads each message once and routes it.
 * The kind is a `batch` kind: ONE Jev call per message (decideMany) whose state is the event and
 * which asks one question per candidate co-worker, its role card as that question's context.
 * Each co-worker still gets its own decision row (subject = the co-worker, requested by = the
 * message's author, who the call is billed to), so "Would pick up", the labels and the
 * agreement read exactly as before.
 *
 * PROMOTION (a reviewed commit, after decisions.kinds and the profile's "Would pick up" show
 * enough agreement with people's labels): change `status: 'shadow'` to `status: 'enforced'`
 * below. A "yes" then queues one 'event' run that answers in the event's thread.
 *
 * Jev reads the co-worker's role card and the event; the criteria are observations of fit
 * with the role, never a judgment of the people in the event. The log keeps the event's
 * metadata (where, who, when) and, only for a public channel, a short excerpt — never a
 * private channel's text (admins read every log row, and may not be in that channel).
 */

const roleCard = (c: CoworkerEventMineInput['coworker']) => [
  `Name: ${c.name}`,
  `Title: ${c.title ?? '(no title)'}`,
  `Accountabilities:\n${c.accountabilities.map((a) => `- ${a}`).join('\n') || '(none)'}`,
  `Lens: ${c.lens}`,
]

const eventText = (e: CoworkerEventMineInput['event'], audience: string) =>
  [
    '# The event',
    `A ${e.isReply ? 'reply in a thread' : 'new message'} in the channel #${e.channelName}, by ${e.authorName} (a person), at ${e.at}. ${audience}`,
    e.body.length > EVENT_STATE_BODY_CHARS ? `${e.body.slice(0, EVENT_STATE_BODY_CHARS)}\n…(truncated)` : e.body,
  ].join('\n')

export const COWORKER_EVENT_MINE_DEF: DecisionKindDef<CoworkerEventMineInput, EventMineChoice> = {
  id: 'coworkers.event_mine',
  module: 'coworkers',
  title: 'Is this event an AI co-worker’s to act on?',
  instructions:
    'An AI co-worker of the company heard this event without being @mentioned. Is it the co-worker’s to act on now — work that belongs to its role, which it should pick up on its own? Compare the event with the role card: its title, accountabilities and lens.',
  choices: ['yes', 'no'],
  criteria: {
    yes: 'The event asks for work, a decision or an answer inside the co-worker’s accountabilities or lens, and the event does not already name someone else to do it.',
    no: 'The event is outside the co-worker’s accountabilities and lens, has nothing to do (social, thanks, a status note), or already names someone else to do it.',
  },
  status: 'shadow',
  lowConfidence: 0,
  state: ({ coworker: c, event: e }) =>
    ['# The AI co-worker (its role card)', ...roleCard(c), '', eventText(e, 'The co-worker is a member of the channel and was not mentioned.')].join('\n'),
  batch: {
    state: ({ event: e }) => eventText(e, 'Every AI co-worker asked about is a member of the channel and was not mentioned.'),
    question: ({ coworker: c }) => ['# The AI co-worker this question is about (its role card)', ...roleCard(c)].join('\n'),
  },
  logInput: ({ coworker: c, event: e }) => ({
    coworkerUserId: c.id,
    eventKind: e.kind,
    eventId: e.id,
    conversationId: e.conversationId,
    threadRootId: e.threadRootId,
    channel: e.channelName,
    privateChannel: e.privateChannel,
    isReply: e.isReply,
    authorId: e.authorId,
    at: e.at,
    bodyChars: e.body.length,
    ...(e.privateChannel ? {} : { excerpt: e.body.length > EVENT_LOG_EXCERPT_CHARS ? `${e.body.slice(0, EVENT_LOG_EXCERPT_CHARS)}…` : e.body }),
  }),
}

export const coworkerEventMine = defineDecisionKind(COWORKER_EVENT_MINE_DEF)
