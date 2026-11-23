import type { CoworkerTriggerKind } from '$lib/server/db/coworkers.schema'

/**
 * A co-worker's system prompt for one turn (plan/phase-ai-coworkers.md §5):
 * assembled fresh every turn from its role card, the org chart, the company,
 * the thread and the trigger, plus the collaboration rules (§6). Pure: the
 * caller reads everything, this only writes it down.
 *
 * Three kinds of turn, by the trigger (structure, never meaning):
 * - mention | dm (C3): it answers in the thread; the thread budget applies.
 * - rhythm (C6): its scheduled check-in; the answer is posted as a new
 *   top-level message in the rhythm's conversation (the recent log is context).
 * - assignment (C6): it works an assigned task; the answer is posted as a
 *   comment on the task, and it completes the task itself (tasks.complete)
 *   when the work is done, or says what blocks it and leaves it open.
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

/** An assigned task as the co-worker sees it (assignment turns). */
export type PromptTask = {
  id: string
  title: string
  context: string
  /** YYYY-MM-DD or null. */
  dueOn: string | null
  assigner: PromptPerson
  /** Oldest first. */
  comments: PromptMessage[]
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
  /** Where it answers or posts; null for an assignment (it works on a task). */
  conversation: { kind: 'channel' | 'dm'; title: string; inThread: boolean } | null
  /** The thread (or DM log, or a rhythm's channel log), oldest first: the last messages only. */
  transcript: PromptMessage[]
  /** Whether older messages of the thread are left out of `transcript`. */
  hasOlder: boolean
  /** The task of an assignment turn; null otherwise. */
  task: PromptTask | null
  /**
   * What asked for the turn: the message (mention, dm), the rhythm's
   * instruction (rhythm, `from` = who set it up), or for an assignment the
   * person's new comment (`body`; the first turn's body is the task's title).
   */
  trigger: { kind: CoworkerTriggerKind; from: PromptPerson; body: string; followUp?: boolean }
  /** Co-worker turns this thread may still take before a person has to step in (this one included); null outside a thread turn. */
  turnsLeft: number | null
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

function thread(input: CoworkerPromptInput, conversation: NonNullable<CoworkerPromptInput['conversation']>): string {
  const where =
    conversation.kind === 'dm' ? `a direct message (${conversation.title})` : `${conversation.title}${conversation.inThread ? ', in a thread' : ''}`
  const older = input.hasOlder ? '(older messages not shown; read them with messages.read or messages.thread)\n' : ''
  const lines = input.transcript.map((m) => `[${m.at}] ${who(m.author)}:\n${m.body.trim() || '(no text)'}`)
  return `# The conversation: ${where}\n${older}${lines.join('\n\n') || '(no messages yet)'}`
}

function task(t: PromptTask): string {
  const lines = [`Title: ${t.title}`, `Task id: ${t.id}`, `Assigned by: ${who(t.assigner)}`, `Due: ${t.dueOn ?? 'no due day'}`]
  lines.push(t.context.trim() ? `What they told you:\n${t.context.trim()}` : 'No further context was given.')
  const comments = t.comments.map((m) => `[${m.at}] ${who(m.author)}:\n${m.body.trim() || '(no text)'}`)
  return `# The task assigned to you\n${lines.join('\n')}\n\nComments so far:\n${comments.join('\n\n') || '(none yet)'}`
}

function trigger(t: CoworkerPromptInput['trigger']): string {
  const body = t.body.trim() || '(no text)'
  if (t.kind === 'rhythm') return `# Why you are acting now\nIt is time for your scheduled check-in, which ${who(t.from)} set up:\n${body}`
  if (t.kind === 'assignment') {
    return t.followUp
      ? `# Why you are acting now\n${who(t.from)} commented on the task:\n${body}`
      : `# Why you are acting now\n${who(t.from)} assigned you the task above.`
  }
  if (t.kind === 'event') {
    return `# Why you are acting now\n${who(t.from)} wrote this in the conversation. Nobody @mentioned you; you noticed it because it looks like yours to act on:\n${body}`
  }
  const how = t.kind === 'dm' ? 'wrote to you in a direct message' : t.kind === 'mention' ? 'mentioned you' : `asked you (${t.kind})`
  return `# Why you are answering now\n${who(t.from)} ${how}:\n${body}`
}

const SHARED_RULES = `- Argue from your accountability and your lens. Do not just agree: when your lens says something is wrong, say so and say why.
- Stay in your role. When something belongs to someone else's accountability, say so and @mention who owns it (see the org chart) with a concrete question.`

function rhythmRules(input: CoworkerPromptInput): string {
  const where = input.conversation?.kind === 'dm' ? 'this direct message' : (input.conversation?.title ?? 'the conversation')
  return `# How you work here
${SHARED_RULES}
- Your answer is posted for you as a new message in ${where}, as you. Do not post it yourself with messages.post.
- Write the post itself, ready to read: no preamble, no greeting, no questions about whether to post.
- Be concise: a few short paragraphs or a list.`
}

function assignmentRules(input: CoworkerPromptInput): string {
  const t = input.task!
  return `# How you work here
${SHARED_RULES}
- Do the work with your tools. Your answer is posted for you as your comment on the task, as you: your result, or what you need. Do not comment yourself with tasks.comment.
- When the task is done, mark it done with tasks.complete (task_id ${t.id}) before you answer.
- When something blocks you, say what blocks it and who can unblock it, and leave the task open.
- Be concise: a few short paragraphs or a list, no filler, no greeting.
- ${t.assigner.name} (${at(t.assigner)}) reads your comment; ${input.self.accountableHuman.name} (${at(input.self.accountableHuman)}) is the person you answer to.`
}

function eventRules(input: CoworkerPromptInput): string {
  return `# How you work here
${SHARED_RULES}
- Nobody asked you: act only on the part that is yours. Do not repeat what others already said or answer what was asked of someone else.
- Your answer is posted for you as a reply in this thread, as you. Do not post it yourself with messages.post.
- Be concise: a few short paragraphs or a list, no filler, no greeting.
- ${input.self.accountableHuman.name} (${at(input.self.accountableHuman)}) is the person you answer to.`
}

function rules(input: CoworkerPromptInput): string {
  if (input.trigger.kind === 'rhythm') return rhythmRules(input)
  if (input.trigger.kind === 'event') return eventRules(input)
  if (input.trigger.kind === 'assignment') return assignmentRules(input)
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

/** The whole system prompt of one co-worker turn. Fails loud on an input that does not fit its trigger. */
export function assembleCoworkerPrompt(input: CoworkerPromptInput): string {
  const kind = input.trigger.kind
  if (kind === 'assignment' && !input.task) throw new Error('an assignment turn needs its task')
  if (kind !== 'assignment' && !input.conversation) throw new Error(`a ${kind} turn needs its conversation`)
  if ((kind === 'mention' || kind === 'dm') && input.turnsLeft === null) throw new Error(`a ${kind} turn needs the thread's turns left`)
  const where = input.task ? task(input.task) : thread(input, input.conversation!)
  return [roleCard(input.self), orgChart(input.org, input.self.id), company(input.company), where, trigger(input.trigger), rules(input)].join('\n\n')
}

/** The turn's input (the durable conversation's user message): the trigger, in one line of context and its words. */
export function coworkerTurnInput(t: CoworkerPromptInput['trigger']): string {
  return `${who(t.from)}:\n${t.body.trim() || '(no text)'}`
}
