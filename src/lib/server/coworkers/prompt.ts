import type { CoworkerTriggerKind } from '$lib/server/db/coworkers.schema'

/**
 * A co-worker's system prompt for one turn (plan/phase-ai-coworkers.md §5):
 * assembled fresh every turn from its role card, the org chart, the company,
 * the thread and the trigger, plus the collaboration rules (§6). Pure: the
 * caller reads everything, this only writes it down.
 */

export type PromptKind = 'human' | 'coworker'

export type PromptPerson = {
  id: string
  name: string
  kind: PromptKind
  /** What people write to reach them: `@<handle>`; null for a former member. */
  handle: string | null
}

export type PromptOrgEntry = PromptPerson & {
  title: string | null
  accountabilities: string[]
  reportsToName: string | null
}

export type PromptMessage = {
  author: PromptPerson
  body: string
  /** ISO time. */
  at: string
}

export type CoworkerPromptInput = {
  self: {
    id: string
    name: string
    handle: string
    title: string | null
    accountabilities: string[]
    lens: string
    reportsTo: { name: string; kind: PromptKind } | null
    accountableHuman: PromptPerson
  }
  org: PromptOrgEntry[]
  company: { name: string | null; profile: string | null; brandVoice: string | null }
  conversation: { kind: 'channel' | 'dm'; title: string; inThread: boolean }
  /** The thread (or DM log), oldest first: the last messages only. */
  transcript: PromptMessage[]
  /** Whether older messages of the thread are left out of `transcript`. */
  hasOlder: boolean
  trigger: { kind: CoworkerTriggerKind; from: PromptPerson; body: string }
  /** Co-worker turns this thread may still take before a person has to step in (this one included). */
  turnsLeft: number
}

const who = (p: PromptPerson) => `${p.name} (${p.handle ? `@${p.handle}, ` : ''}${p.kind === 'coworker' ? 'AI co-worker' : 'person'})`
const at = (p: PromptPerson) => (p.handle ? `@${p.handle}` : p.name)

const bullets = (items: string[]) => items.map((a) => `- ${a}`).join('\n')

function roleCard(self: CoworkerPromptInput['self']): string {
  const lines = [
    `You are ${self.name} (${at({ ...self, kind: 'coworker' })}), an AI co-worker at this company: a colleague with your own seat, not an assistant to anyone.`,
    `Title: ${self.title ?? 'none set'}`,
    self.accountabilities.length > 0 ? `You are accountable for:\n${bullets(self.accountabilities)}` : 'You have no accountabilities set yet.',
    `Your lens (what you care about, what you push back on):\n${self.lens}`,
    `You report to: ${self.reportsTo ? `${self.reportsTo.name} (${self.reportsTo.kind === 'coworker' ? 'AI co-worker' : 'person'})` : 'nobody in the org chart'}.`,
    `The person you answer to: ${who(self.accountableHuman)}. Approvals you need and anything that needs a person go to them.`,
  ]
  return `# Your role\n${lines.join('\n')}`
}

function orgChart(org: PromptOrgEntry[], selfId: string): string {
  const rows = org.map((p) => {
    const me = p.id === selfId ? ' — you' : ''
    const title = p.title ?? 'no title'
    const reports = p.reportsToName ? `, reports to ${p.reportsToName}` : ''
    const owns = p.accountabilities.length > 0 ? `; owns: ${p.accountabilities.join('; ')}` : ''
    return `- ${who(p)}: ${title}${reports}${owns}${me}`
  })
  return `# Who is who (the org chart)\nMention someone with their @handle to bring them in.\n${rows.join('\n')}`
}

function company(c: CoworkerPromptInput['company']): string {
  const lines = [`Name: ${c.name ?? 'not named yet'}`]
  if (c.profile) lines.push(`What the company does: ${c.profile}`)
  if (c.brandVoice) lines.push(`Brand voice: ${c.brandVoice}`)
  return `# The company\n${lines.join('\n')}`
}

function thread(input: CoworkerPromptInput): string {
  const where =
    input.conversation.kind === 'dm'
      ? `a direct message (${input.conversation.title})`
      : `${input.conversation.title}${input.conversation.inThread ? ', in a thread' : ''}`
  const older = input.hasOlder ? '(older messages not shown; read them with messages.read or messages.thread)\n' : ''
  const lines = input.transcript.map((m) => `[${m.at}] ${who(m.author)}:\n${m.body.trim() || '(no text)'}`)
  return `# The conversation: ${where}\n${older}${lines.join('\n\n') || '(no messages yet)'}`
}

function trigger(t: CoworkerPromptInput['trigger']): string {
  const how = t.kind === 'dm' ? 'wrote to you in a direct message' : t.kind === 'mention' ? 'mentioned you' : `asked you (${t.kind})`
  return `# Why you are answering now\n${who(t.from)} ${how}:\n${t.body.trim() || '(no text)'}`
}

function rules(input: CoworkerPromptInput): string {
  const human = input.self.accountableHuman
  return `# How you work here
- Argue from your accountability and your lens. Do not just agree: when your lens says something is wrong, say so and say why.
- Stay in your role. When something belongs to someone else's accountability, say so and @mention who owns it (see the org chart) with a concrete question.
- Your colleagues answer in this same thread when you @mention them; you then get a turn again when someone @mentions you.
- Be concise: a few short paragraphs or a list, no filler, no greeting.
- End by answering whoever asked you (${at(input.trigger.from)}), with your result or the one thing you need from them.
- Your answer is posted to this conversation for you, as you. Do not post it yourself with messages.post.
- This thread has ${input.turnsLeft} co-worker turn${input.turnsLeft === 1 ? '' : 's'} left before ${human.name} (${at(human)}) has to step in; do not spend them on back-and-forth.`
}

/** The whole system prompt of one co-worker turn. */
export function assembleCoworkerPrompt(input: CoworkerPromptInput): string {
  return [roleCard(input.self), orgChart(input.org, input.self.id), company(input.company), thread(input), trigger(input.trigger), rules(input)].join(
    '\n\n',
  )
}

/** The turn's input (the durable conversation's user message): the trigger, in one line of context and its words. */
export function coworkerTurnInput(t: CoworkerPromptInput['trigger']): string {
  return `${who(t.from)}:\n${t.body.trim() || '(no text)'}`
}
