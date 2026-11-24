import { describe, expect, it } from 'vitest'
import { assembleCoworkerPrompt, coworkerTurnInput, type CoworkerPromptInput, type PromptPerson } from './prompt'

/** A co-worker's per-turn system prompt (plan/phase-ai-coworkers.md §5): pure assembly, every section present. */

const ann: PromptPerson = { id: 'ann', name: 'Ann Owner', kind: 'human', handle: 'ann' }
const gtm: PromptPerson = { id: 'cw-gtm', name: 'GTM', kind: 'coworker', handle: 'gtm' }
const marketing: PromptPerson = { id: 'cw-mkt', name: 'Marketing', kind: 'coworker', handle: 'marketing' }

function input(over: Partial<CoworkerPromptInput> = {}): CoworkerPromptInput {
  return {
    self: {
      id: 'cw-mkt',
      name: 'Marketing',
      handle: 'marketing',
      title: 'Marketing Manager',
      accountabilities: ['Pipeline from campaigns', 'Brand consistency'],
      lens: 'Growth through clear positioning. Push back on launches without a story.',
      reportsTo: { name: 'Ann Owner', kind: 'human' },
      accountableHuman: ann,
    },
    org: [
      { ...ann, title: 'CEO', accountabilities: ['Everything'], reportsToName: null },
      { ...marketing, title: 'Marketing Manager', accountabilities: ['Pipeline from campaigns'], reportsToName: 'Ann Owner' },
      { ...gtm, title: 'Go-to-Market Manager', accountabilities: ['Pricing', 'Channels'], reportsToName: 'Marketing' },
    ],
    company: { name: 'Kindred Labs', profile: 'We build calm software for small teams.', brandVoice: 'warm, plain, direct' },
    conversation: { kind: 'channel', title: '#launch', inThread: true },
    transcript: [
      { author: ann, body: '@marketing plan the launch', at: '2026-11-23T09:00:00.000Z' },
      { author: gtm, body: 'Price at $12 per seat.', at: '2026-11-23T09:02:00.000Z' },
    ],
    hasOlder: false,
    task: null,
    trigger: { kind: 'mention', from: gtm, body: '@marketing does that fit the story?' },
    turnsLeft: 6,
    ...over,
  }
}

describe('assembleCoworkerPrompt', () => {
  it('the role card: name, handle, title, accountabilities, lens, reports-to, accountable human', () => {
    const p = assembleCoworkerPrompt(input())
    expect(p).toContain('You are Marketing (@marketing), an AI co-worker')
    expect(p).toContain('Title: Marketing Manager')
    expect(p).toContain('- Pipeline from campaigns\n- Brand consistency')
    expect(p).toContain('Push back on launches without a story.')
    expect(p).toContain('You report to: Ann Owner (person).')
    expect(p).toContain('The person you answer to: Ann Owner (@ann, person).')
  })

  it('the org chart: everyone with title, kind and @handle, so it knows whom to ask', () => {
    const p = assembleCoworkerPrompt(input())
    expect(p).toContain('- Ann Owner (@ann, person): CEO; owns: Everything')
    expect(p).toContain('- GTM (@gtm, AI co-worker): Go-to-Market Manager, reports to Marketing; owns: Pricing; Channels')
    expect(p).toContain('- Marketing (@marketing, AI co-worker): Marketing Manager, reports to Ann Owner; owns: Pipeline from campaigns — you')
  })

  it('the company: name, what it does, brand voice — and nothing made up when absent', () => {
    const p = assembleCoworkerPrompt(input())
    expect(p).toContain('# The company\nName: Kindred Labs\nWhat the company does: We build calm software for small teams.\nBrand voice: warm, plain, direct')
    const bare = assembleCoworkerPrompt(input({ company: { name: null, profile: null, brandVoice: null } }))
    expect(bare).toContain('# The company\nName: not named yet\n\n')
    expect(bare).not.toContain('Brand voice')
  })

  it('the thread with each author’s kind, the trigger, and the collaboration rules', () => {
    const p = assembleCoworkerPrompt(input())
    expect(p).toContain('# The conversation: #launch, in a thread')
    expect(p).toContain('[2026-11-23T09:00:00.000Z] Ann Owner (@ann, person):\n@marketing plan the launch')
    expect(p).toContain('[2026-11-23T09:02:00.000Z] GTM (@gtm, AI co-worker):\nPrice at $12 per seat.')
    expect(p).toContain('# Why you are answering now\nGTM (@gtm, AI co-worker) mentioned you:\n@marketing does that fit the story?')
    expect(p).toContain('Argue from your accountability and your lens')
    expect(p).toContain('when your lens says something is wrong, say so')
    expect(p).toContain('@mention who owns it')
    expect(p).toContain('Be concise')
    expect(p).toContain('End by answering whoever asked you (@gtm)')
    expect(p).toContain('Do not post it yourself with messages.post')
    expect(p).toContain('This thread has 6 co-worker turns left before Ann Owner (@ann) has to step in')
  })

  it('sections come in a fixed order', () => {
    const p = assembleCoworkerPrompt(input())
    const order = ['# Your role', '# Who is who', '# The company', '# The conversation', '# Why you are answering now', '# How you work here'].map((h) => p.indexOf(h))
    expect(order.every((at) => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('a DM, older messages left out, a former member and the last turn', () => {
    const gone: PromptPerson = { id: 'x', name: 'Former member', kind: 'human', handle: null }
    const p = assembleCoworkerPrompt(
      input({
        conversation: { kind: 'dm', title: 'Ann Owner', inThread: false },
        hasOlder: true,
        transcript: [{ author: gone, body: 'old note', at: '2026-11-20T09:00:00.000Z' }],
        trigger: { kind: 'dm', from: ann, body: 'quick one' },
        turnsLeft: 1,
      }),
    )
    expect(p).toContain('# The conversation: a direct message (Ann Owner)\n(older messages not shown')
    expect(p).toContain('Former member (person):\nold note')
    expect(p).toContain('Ann Owner (@ann, person) wrote to you in a direct message:\nquick one')
    expect(p).toContain('This thread has 1 co-worker turn left')
  })

  it('the turn input is the trigger itself, with who sent it', () => {
    expect(coworkerTurnInput({ kind: 'mention', from: ann, body: ' @marketing plan the launch ' })).toBe('Ann Owner (@ann, person):\n@marketing plan the launch')
  })

  it('a rhythm turn: the scheduled instruction, the channel log as context, posted as a new message', () => {
    const p = assembleCoworkerPrompt(
      input({
        conversation: { kind: 'channel', title: '#marketing', inThread: false },
        trigger: { kind: 'rhythm', from: ann, body: 'Post the marketing standup: yesterday, today, blockers.' },
        turnsLeft: null,
      }),
    )
    expect(p).toContain('# The conversation: #marketing\n')
    expect(p).toContain('# Why you are acting now\nIt is time for your scheduled check-in, which Ann Owner (@ann, person) set up:\nPost the marketing standup')
    expect(p).toContain('posted for you as a new message in #marketing')
    expect(p).toContain('Do not post it yourself with messages.post')
    expect(p).not.toContain('co-worker turns left')
  })

  it('an assignment turn: the task with its comments, posted as a comment, completed with tasks.complete', () => {
    const task = {
      id: 'task-1',
      title: 'Draft the launch email',
      context: 'For the December list.',
      dueOn: '2026-12-01',
      assigner: ann,
      comments: [{ author: ann, body: 'Keep it short.', at: '2026-11-23T10:00:00.000Z' }],
    }
    const first = assembleCoworkerPrompt(input({ conversation: null, transcript: [], task, trigger: { kind: 'assignment', from: ann, body: task.title }, turnsLeft: null }))
    expect(first).toContain('# The task assigned to you\nTitle: Draft the launch email\nTask id: task-1\nAssigned by: Ann Owner (@ann, person)\nDue: 2026-12-01')
    expect(first).toContain('What they told you:\nFor the December list.')
    expect(first).toContain('[2026-11-23T10:00:00.000Z] Ann Owner (@ann, person):\nKeep it short.')
    expect(first).toContain('Ann Owner (@ann, person) assigned you the task above.')
    expect(first).toContain('mark it done with tasks.complete (task_id task-1)')
    expect(first).toContain('say what blocks it and who can unblock it, and leave the task open')
    expect(first).toContain('Do not comment yourself with tasks.comment')
    expect(first).not.toContain('# The conversation')
    const followUp = assembleCoworkerPrompt(
      input({ conversation: null, transcript: [], task, trigger: { kind: 'assignment', from: ann, body: 'Add the price.', followUp: true }, turnsLeft: null }),
    )
    expect(followUp).toContain('Ann Owner (@ann, person) commented on the task:\nAdd the price.')
  })

  it('fails loud on an input that does not fit its trigger', () => {
    expect(() => assembleCoworkerPrompt(input({ trigger: { kind: 'assignment', from: ann, body: 'x' }, turnsLeft: null }))).toThrow('needs its task')
    expect(() => assembleCoworkerPrompt(input({ conversation: null, trigger: { kind: 'rhythm', from: ann, body: 'x' } }))).toThrow('needs its conversation')
    expect(() => assembleCoworkerPrompt(input({ turnsLeft: null }))).toThrow("needs the thread's turns left")
  })

  it('lists multiple managers and multiple accountable humans when present', () => {
    const bea: PromptPerson = { id: 'bea', name: 'Bea Member', kind: 'human', handle: 'bea' }
    const p = assembleCoworkerPrompt(
      input({
        self: {
          ...input().self,
          reportsTo: { name: 'Ann Owner', kind: 'human' },
          reportsToList: [
            { name: 'Ann Owner', kind: 'human' },
            { name: 'GTM', kind: 'coworker' },
          ],
          accountableHuman: ann,
          accountableHumans: [ann, bea],
        },
        org: [
          { ...ann, title: 'CEO', accountabilities: ['Everything'], reportsToName: null, reportsToNames: [] },
          {
            ...marketing,
            title: 'Marketing Manager',
            accountabilities: ['Pipeline from campaigns'],
            reportsToName: 'Ann Owner',
            reportsToNames: ['Ann Owner', 'GTM'],
          },
          { ...gtm, title: 'Go-to-Market Manager', accountabilities: ['Pricing', 'Channels'], reportsToName: 'Ann Owner', reportsToNames: ['Ann Owner'] },
        ],
      }),
    )
    expect(p).toContain('You report to: Ann Owner (person); GTM (AI co-worker).')
    expect(p).toContain('The people you answer to: Ann Owner (@ann, person); Bea Member (@bea, person).')
    expect(p).toContain('Marketing (@marketing, AI co-worker): Marketing Manager, reports to Ann Owner, GTM;')
    expect(p).toContain('before Ann Owner (@ann) or Bea Member (@bea) have to step in')
  })
})
