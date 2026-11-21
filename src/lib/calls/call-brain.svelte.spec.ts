import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { FakeMediaRecorder, installVoiceDoubles } from '$lib/test/voice-doubles'
import { ActiveCall } from './active-call.svelte'
import BrainRecap from './brain-recap.svelte'
import { CallBrain } from './call-brain.svelte'
import CallView from './call-view.svelte'
import { CallRequestError, type BrainAnswerDto, type BrainClient, type CallBrainDto, type CallDto } from './client'
import { FakeRoom, fakeCall, fakeEnv, fakeToken } from './fake-room'

/**
 * The Company Brain in the call view (modules/calls/brain.ts): the indicator
 * everyone in the call sees, the switch, "Ask the Brain", my private answers
 * with "Share in call", what colleagues shared, and the recap offered after
 * the call to whoever switched it on. Over a fake room and a fake server.
 */

const OFF: CallBrainDto = { listening: false, by: null, byName: null, since: null, turnedOnBy: [], shared: [] }
const ON: CallBrainDto = { listening: true, by: 'ben', byName: 'Ben Example', since: '2026-11-19T10:00:00.000Z', turnedOnBy: ['ben'], shared: [] }

const live = (brain: CallBrainDto = OFF): CallDto =>
  fakeCall({
    state: 'active',
    answeredAt: new Date().toISOString(),
    participants: [
      { userId: 'ben', name: 'Ben Example', guest: false, response: 'accepted', joinedAt: new Date().toISOString(), leftAt: null, inRoom: true, transcribing: true },
      { userId: 'ann', name: 'Ann Example', guest: false, response: 'accepted', joinedAt: new Date().toISOString(), leftAt: null, inRoom: true, transcribing: true },
    ],
    brain,
  })

function setup(opts: { call?: CallDto; member?: boolean; brainClient?: Partial<BrainClient> } = {}) {
  let call = opts.call ?? live()
  const room = new FakeRoom()
  const env = fakeEnv()
  const client = {
    accept: vi.fn(async () => call),
    token: vi.fn(async () => fakeToken),
    hangup: vi.fn(async () => ({ ...call, state: 'ended' as const })),
    get: vi.fn(async () => ({ ...call, state: 'ended' as const })),
  }
  const active = new ActiveCall({ client, createRoom: async () => room, env: () => env })
  const answer: BrainAnswerDto = { id: 'a1', question: 'Wann geht das Angebot raus?', answer: 'Ann sagte: morgen.', askedAt: '2026-11-19T10:01:00.000Z', shared: false }
  const brainApi: BrainClient = {
    setBrain: vi.fn(async (_id: string, on: boolean) => (call = { ...call, brain: on ? { ...ON, by: 'ann', byName: 'Ann Example', turnedOnBy: ['ann'] } : { ...OFF, turnedOnBy: ['ann'] } })),
    askBrain: vi.fn(async (_id: string, question: string) => ({ ...answer, question })),
    myBrainAnswers: vi.fn(async () => []),
    shareBrainAnswer: vi.fn(
      async () =>
        (call = {
          ...call,
          brain: { ...call.brain, shared: [{ id: 'a1', askedBy: 'ann', askedByName: 'Ann Example', question: answer.question, answer: answer.answer, askedAt: answer.askedAt, sharedAt: answer.askedAt }] },
        }),
    ),
    brainRecap: vi.fn(async () => 'Entschieden: Angebot geht morgen raus.'),
    ...opts.brainClient,
  }
  const member = opts.member !== false
  const brain = member ? new CallBrain({ active, me: 'ann', client: brainApi }) : null
  render(CallView, {
    active,
    call,
    me: 'ann',
    leaveLabel: 'Close',
    onleave: vi.fn(),
    onhungup: vi.fn(),
    onopen: vi.fn(),
    brain,
    brainRecap: member ? brainApi : null,
  })
  return { active, room, brainApi, brain }
}

const connected = () => expect.element(page.getByTestId('call-view')).toHaveAttribute('data-phase', 'connected')

describe('call-view.svelte: Company Brain', () => {
  it('off by default: no indicator; the Brain button opens its panel, off, with the ask field disabled', async () => {
    const { brainApi } = setup()
    await connected()
    expect(page.getByTestId('call-brain-indicator').elements()).toHaveLength(0)
    await page.getByTestId('call-brain-button').click()
    await expect.element(page.getByTestId('call-brain-state')).toHaveTextContent('Off')
    await expect.element(page.getByTestId('call-brain-toggle')).toHaveAttribute('aria-checked', 'false')
    await expect.element(page.getByTestId('call-brain-question')).toBeDisabled()
    expect(brainApi.myBrainAnswers).toHaveBeenCalledWith('call-1')
    expect(brainApi.askBrain).not.toHaveBeenCalled()
  })

  it('switching it on: the indicator for everyone, who switched it on; switching off removes it', async () => {
    const { brainApi } = setup()
    await connected()
    await page.getByTestId('call-brain-button').click()
    await page.getByTestId('call-brain-toggle').click()
    expect(brainApi.setBrain).toHaveBeenCalledWith('call-1', true)
    await expect.element(page.getByTestId('call-brain-indicator')).toHaveTextContent('Company Brain listening')
    await expect.element(page.getByTestId('call-brain-state')).toHaveTextContent('Listening · switched on by Ann Example')
    await page.getByTestId('call-brain-toggle').click()
    expect(brainApi.setBrain).toHaveBeenLastCalledWith('call-1', false)
    await expect.element(page.getByTestId('call-brain-state')).toHaveTextContent('Off')
    expect(page.getByTestId('call-brain-indicator').elements()).toHaveLength(0)
    expect(brainApi.askBrain).not.toHaveBeenCalled()
  })

  it('someone else switched it on: I see it listening (from the call feed) and who did', async () => {
    setup({ call: live(ON) })
    await connected()
    await expect.element(page.getByTestId('call-brain-indicator')).toHaveAttribute('title', expect.stringContaining('Ben Example switched the Company Brain on'))
  })

  it('a guest sees the indicator but has no Brain button or panel', async () => {
    setup({ call: live(ON), member: false })
    await connected()
    await expect.element(page.getByTestId('call-brain-indicator')).toBeInTheDocument()
    expect(page.getByTestId('call-brain-button').elements()).toHaveLength(0)
  })

  it('Ask the Brain: my answer, only for me — then Share in call shows it to everyone, from the Brain, asked by me', async () => {
    const { brainApi } = setup({ call: live(ON) })
    await connected()
    await page.getByTestId('call-brain-button').click()
    await page.getByTestId('call-brain-question').fill('Wann geht das Angebot raus?')
    await page.getByTestId('call-brain-send').click()
    expect(brainApi.askBrain).toHaveBeenCalledWith('call-1', 'Wann geht das Angebot raus?')
    const mine = page.getByTestId('call-brain-answer')
    await expect.element(mine).toHaveTextContent('Ann sagte: morgen.')
    await expect.element(mine).toHaveAttribute('data-shared', 'false')
    await expect.element(page.getByText('Only you see these')).toBeInTheDocument()
    await expect.element(page.getByTestId('call-brain-question')).toHaveValue('')
    expect(page.getByTestId('call-brain-shared').elements()).toHaveLength(0)

    await page.getByTestId('call-brain-share').click()
    expect(brainApi.shareBrainAnswer).toHaveBeenCalledWith('call-1', 'a1')
    await expect.element(mine).toHaveAttribute('data-shared', 'true')
    await expect.element(page.getByTestId('call-brain-shared-label')).toHaveTextContent('Company Brain · asked by Ann Example')
    await expect.element(page.getByTestId('call-brain-shared')).toHaveTextContent('Ann sagte: morgen.')
  })

  it('Ask the Brain takes dictation: the words land in the question, focused, and nothing is asked until I tap Ask', async () => {
    const doubles = installVoiceDoubles()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ transcript: 'wann geht das Angebot raus' })))
    try {
      const { brainApi } = setup({ call: live(ON) })
      await connected()
      await page.getByTestId('call-brain-button').click()
      await page.getByTestId('call-brain-voice-mic').click()
      await expect.element(page.getByTestId('call-brain-voice-bar')).toBeInTheDocument()
      await expect.element(page.getByTestId('call-brain-send')).not.toBeInTheDocument()
      FakeMediaRecorder.instances.at(-1)!.emitChunk([1, 2, 3])
      await page.getByTestId('call-brain-voice-send').click()
      await expect.element(page.getByTestId('call-brain-question')).toHaveValue('wann geht das Angebot raus')
      await expect.element(page.getByTestId('call-brain-question')).toHaveFocus()
      await expect.element(page.getByTestId('call-brain-send')).toBeEnabled()
      expect(brainApi.askBrain).not.toHaveBeenCalled()
    } finally {
      doubles.restore()
      vi.unstubAllGlobals()
    }
  })

  it('a refused ask says why, in the server’s words, and keeps my question', async () => {
    setup({
      call: live(ON),
      brainClient: { askBrain: vi.fn(async () => Promise.reject(new CallRequestError({ kind: 'failed', message: 'the Company Brain is not listening to this call' }))) },
    })
    await connected()
    await page.getByTestId('call-brain-button').click()
    await page.getByTestId('call-brain-question').fill('Hallo?')
    await page.getByTestId('call-brain-send').click()
    await expect.element(page.getByTestId('call-brain-problem')).toHaveTextContent('the Company Brain is not listening to this call')
    await expect.element(page.getByTestId('call-brain-question')).toHaveValue('Hallo?')
  })

  it('after the call: whoever switched it on is offered a recap — generated only on the click', async () => {
    const { room, brainApi } = setup({ call: live({ ...OFF, turnedOnBy: ['ann'] }) })
    await connected()
    room.emit({ type: 'disconnected', reason: 'call_over' })
    await expect.element(page.getByTestId('call-ended')).toBeInTheDocument()
    expect(brainApi.brainRecap).not.toHaveBeenCalled()
    await page.getByTestId('call-brain-recap-button').click()
    expect(brainApi.brainRecap).toHaveBeenCalledWith('call-1')
    await expect.element(page.getByTestId('call-brain-recap-text')).toHaveTextContent('Entschieden: Angebot geht morgen raus.')
  })

  it('after the call: no recap offer for someone who did not switch it on', async () => {
    const { room } = setup({ call: live({ ...OFF, turnedOnBy: ['ben'] }) })
    await connected()
    room.emit({ type: 'disconnected', reason: 'call_over' })
    await expect.element(page.getByTestId('call-ended')).toBeInTheDocument()
    expect(page.getByTestId('call-brain-recap').elements()).toHaveLength(0)
  })
})

describe('brain-recap.svelte', () => {
  it('a refused recap says why', async () => {
    const client = { brainRecap: vi.fn(async () => Promise.reject(new CallRequestError({ kind: 'failed', message: 'the Company Brain heard nothing in this call' }))) }
    render(BrainRecap, { callId: 'call-9', client })
    await page.getByTestId('call-brain-recap-button').click()
    expect(client.brainRecap).toHaveBeenCalledWith('call-9')
    await expect.element(page.getByTestId('call-brain-recap-problem')).toHaveTextContent('the Company Brain heard nothing in this call')
  })
})
