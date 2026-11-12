import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { ActiveCall, type CallEnv } from './active-call.svelte'
import CallView from './call-view.svelte'
import { CallRequestError, type CallDto, type CallTokenDto } from './client'
import { DEVICES_KEY } from './devices'
import { FakeRoom, fakeCall, fakeEnv, fakeToken, memoryStorage, remotePerson } from './fake-room'
import { LiveCalls } from './live-calls.svelte'
import MiniCall from './mini-call.svelte'

/** The live call as the nucleus layout holds it, over a fake room (no server). */
function liveCall(opts: { room?: FakeRoom; env?: Partial<CallEnv>; token?: () => Promise<CallTokenDto> } = {}) {
  const room = opts.room ?? new FakeRoom()
  const env = fakeEnv(opts.env)
  const client = {
    accept: vi.fn(async () => fakeCall()),
    token: vi.fn(opts.token ?? (async () => fakeToken)),
    hangup: vi.fn(async () => fakeCall({ state: 'ended' })),
    get: vi.fn(async () => fakeCall({ state: 'missed' })),
  }
  const createRoom = vi.fn(async () => room)
  const active = new ActiveCall({ client, createRoom, env: () => env })
  return { active, room, env, client, createRoom }
}

function view(active: ActiveCall, call: CallDto = fakeCall()) {
  const onleave = vi.fn()
  const onopen = vi.fn()
  const r = render(CallView, { active, call, me: 'ann', onleave, onopen })
  return { onleave, onopen, r }
}

function setup(opts: Parameters<typeof liveCall>[0] & { call?: CallDto } = {}) {
  const l = liveCall(opts)
  return { ...l, ...view(l.active, opts.call) }
}

const connected = () => expect.element(page.getByTestId('call-view')).toHaveAttribute('data-phase', 'connected')
const tile = (identity: string, kind = 'camera') => page.getByTestId('call-grid').locator(`[data-testid="call-tile"][data-identity="${identity}"][data-kind="${kind}"]`)

describe('call-view.svelte', () => {
  it('accepts when I have not, fetches a token, joins the room, turns mic + camera on', async () => {
    const { room, client } = setup({ call: fakeCall({}, 'none') })
    await connected()
    expect(client.accept).toHaveBeenCalledWith('call-1')
    expect(client.token).toHaveBeenCalledWith('call-1')
    expect(room.connectedWith).toEqual(['wss://rtc.example.test', 'tok'])
    await expect.element(page.getByTestId('call-mic')).toHaveAttribute('data-on', 'true')
    await expect.element(page.getByTestId('call-camera')).toHaveAttribute('data-on', 'true')
    await expect.element(tile('ann')).toHaveAttribute('data-local', 'true')
    await expect.element(tile('ann')).toHaveAttribute('data-video', 'true')
    await expect.element(page.getByTestId('call-status')).toHaveTextContent('Waiting for others to join…')
  })

  it('does not accept again when I already did', async () => {
    const { client } = setup()
    await connected()
    expect(client.accept).not.toHaveBeenCalled()
  })

  it('two people: the other person fills the stage, I am the small self view; names and muted shown', async () => {
    const { room } = setup()
    await connected()
    room.remote = [remotePerson()]
    room.emit({ type: 'participants' })
    await expect.element(page.getByTestId('call-view')).toHaveAttribute('data-mode', 'pair')
    const ben = tile('ben')
    await expect.element(ben).toHaveAttribute('data-muted', 'true')
    await expect.element(ben.getByTestId('call-muted')).toBeInTheDocument()
    await expect.element(ben.getByTestId('call-tile-name')).toHaveTextContent('Ben Example')
    await expect.element(page.getByTestId('call-status')).toHaveTextContent('2 in the call')
    const video = ben.getByTestId('call-video').element() as HTMLVideoElement
    expect(video.srcObject).toBe(room.remote[0].camera)
    await expect.element(tile('ann').getByTestId('call-tile-name')).toHaveTextContent('Ann Example (you)')
  })

  it('three or more: a grid, the active speaker emphasised', async () => {
    const { room } = setup()
    await connected()
    room.remote = [remotePerson(), remotePerson({ identity: 'cy', name: 'Cy Example', speaking: true })]
    room.emit({ type: 'participants' })
    await expect.element(page.getByTestId('call-view')).toHaveAttribute('data-mode', 'grid')
    await expect.element(tile('cy')).toHaveAttribute('data-speaker', 'true')
    await expect.element(tile('ben')).toHaveAttribute('data-speaker', 'false')
    expect(page.getByTestId('call-grid').getByTestId('call-tile').elements()).toHaveLength(3)
  })

  it('a screen share takes the big area, everyone else goes into the strip', async () => {
    const { room } = setup()
    await connected()
    room.remote = [remotePerson({ screen: new MediaStream() }), remotePerson({ identity: 'cy', name: 'Cy Example' })]
    room.emit({ type: 'participants' })
    await expect.element(page.getByTestId('call-view')).toHaveAttribute('data-mode', 'focus')
    await expect.element(tile('ben', 'screen')).toBeInTheDocument()
    const strip = page.getByTestId('call-strip').getByTestId('call-tile')
    expect(strip.elements().map((e) => (e as HTMLElement).dataset.identity)).toEqual(['ann', 'ben', 'cy'])
  })

  it('mute, camera off and screen share drive the room', async () => {
    const { room } = setup()
    await expect.element(page.getByTestId('call-mic')).toHaveAttribute('data-on', 'true')
    await page.getByRole('button', { name: 'Mute' }).click()
    expect(room.devices.microphone).toBe(false)
    await expect.element(page.getByTestId('call-mic')).toHaveAttribute('aria-pressed', 'true')
    await expect.element(tile('ann')).toHaveAttribute('data-muted', 'true')

    await page.getByRole('button', { name: 'Turn camera off' }).click()
    expect(room.devices.camera).toBe(false)
    await expect.element(tile('ann')).toHaveAttribute('data-video', 'false')

    await page.getByRole('button', { name: 'Share screen' }).click()
    expect(room.devices.screen).toBe(true)
    await expect.element(tile('ann', 'screen')).toBeInTheDocument()
    // The browser's own "Stop sharing" ends it too.
    room.devices.screen = false
    room.emit({ type: 'media', device: 'screen', on: false })
    await expect.element(page.getByRole('button', { name: 'Share screen' })).toBeInTheDocument()
  })

  it('hang up leaves the room, tells the server once, then leaves the page', async () => {
    const { room, client, onleave, r } = setup()
    await connected()
    await page.getByTestId('call-hangup').click()
    await vi.waitFor(() => expect(onleave).toHaveBeenCalledOnce())
    expect(room.disconnects).toBe(1)
    expect(client.hangup).toHaveBeenCalledExactlyOnceWith('call-1', { keepalive: false })
    r.unmount()
    expect(client.hangup).toHaveBeenCalledOnce()
  })

  it('leaving the page keeps the call; coming back shows it again without joining twice, video attached', async () => {
    const { active, room, client, createRoom, r } = setup()
    await connected()
    room.remote = [remotePerson()]
    room.emit({ type: 'participants' })
    await expect.element(tile('ben')).toHaveAttribute('data-video', 'true')
    r.unmount()
    expect(room.disconnects).toBe(0)
    expect(client.hangup).not.toHaveBeenCalled()
    expect(active.inCall).toBe(true)

    view(active)
    await connected()
    const video = tile('ben').getByTestId('call-video').element() as HTMLVideoElement
    expect(video.srcObject).toBe(room.remote[0].camera)
    expect(createRoom).toHaveBeenCalledOnce()
    expect(client.token).toHaveBeenCalledOnce()
  })

  it('another call while I am in one: says so plainly, joins nothing, offers my call', async () => {
    const { active, client } = liveCall()
    active.open(fakeCall(), 'ann')
    await vi.waitFor(() => expect(active.state.phase).toBe('connected'))
    const { onopen } = view(active, fakeCall({ id: 'call-2', title: 'Design review' }))
    const busy = page.getByTestId('call-busy')
    await expect.element(busy.getByRole('alert')).toHaveTextContent("You're already in a call: Ann Example, Ben Example.")
    await expect.element(busy).toHaveTextContent('Hang up that call first to join this one.')
    expect(page.getByTestId('call-controls').elements()).toHaveLength(0)
    await page.getByTestId('call-busy-back').click()
    expect(onopen).toHaveBeenCalledExactlyOnceWith('call-1')
    expect(client.token).toHaveBeenCalledOnce()
    expect(active.call?.id).toBe('call-1')
  })

  it('calls not set up: says so plainly, creates no room', async () => {
    const { createRoom } = setup({
      token: async () => {
        throw new CallRequestError({ kind: 'not_configured', message: 'Calls are not set up on this server' })
      },
    })
    const problem = page.getByTestId('call-problem')
    await expect.element(problem).toHaveAttribute('data-kind', 'not_configured')
    await expect.element(problem.getByRole('alert')).toHaveTextContent('Calls are not set up on this server')
    expect(createRoom).not.toHaveBeenCalled()
    expect(page.getByTestId('call-controls').elements()).toHaveLength(0)
  })

  it('camera permission denied: stays in the call with a message that says what to do', async () => {
    const room = new FakeRoom()
    room.failures.camera = 'permission_denied'
    setup({ room })
    const notice = page.getByTestId('call-notice')
    await expect.element(notice).toHaveAttribute('data-device', 'camera')
    await expect.element(notice).toHaveTextContent(/blocked the camera.*Allow camera access/)
    await connected()
    await expect.element(page.getByTestId('call-mic')).toHaveAttribute('data-on', 'true')
    await expect.element(page.getByTestId('call-camera')).toHaveAttribute('data-on', 'false')
  })

  it('the call closing on the server ends the view with how it ended', async () => {
    const { room, client } = setup()
    await connected()
    room.emit({ type: 'disconnected', reason: 'call_over' })
    await expect.element(page.getByTestId('call-ended')).toHaveAttribute('data-reason', 'call_over')
    await expect.element(page.getByTestId('call-ended')).toHaveTextContent('Nobody answered.')
    expect(client.get).toHaveBeenCalledWith('call-1')
  })

  it('a lost connection offers Rejoin, which joins again', async () => {
    const { room, client } = setup()
    await connected()
    room.emit({ type: 'disconnected', reason: 'connection_lost' })
    await page.getByTestId('call-rejoin').click()
    await connected()
    expect(client.token).toHaveBeenCalledTimes(2)
  })
})

describe('device picker in the call controls', () => {
  it('lists microphone, speaker and camera; a choice switches the call and is remembered', async () => {
    const storage = memoryStorage()
    const { room } = setup({ env: { storage } })
    await connected()
    await page.getByTestId('call-devices-toggle').click()
    const mic = page.getByTestId('call-device-audioinput')
    await expect.element(mic).toHaveValue('default')
    expect((mic.element() as HTMLSelectElement).options).toHaveLength(2)
    await mic.selectOptions('mic-usb')
    await vi.waitFor(() => expect(room.switches).toEqual([['audioinput', 'mic-usb']]))
    await page.getByTestId('call-device-videoinput').selectOptions('cam-2')
    await page.getByTestId('call-device-audiooutput').selectOptions('spk-usb')
    await vi.waitFor(() => expect(room.switches).toHaveLength(3))
    expect(JSON.parse(storage.data[DEVICES_KEY])).toEqual({ audioinput: 'mic-usb', videoinput: 'cam-2', audiooutput: 'spk-usb' })
    await expect.element(page.getByTestId('call-device-videoinput')).toHaveValue('cam-2')
  })

  it('a browser that cannot choose the speaker says so (the speaker is not hidden silently)', async () => {
    setup({ env: { canChooseSpeaker: false } })
    await connected()
    await page.getByTestId('call-devices-toggle').click()
    await expect.element(page.getByTestId('call-speaker-unsupported')).toHaveTextContent('This browser cannot choose the speaker for calls.')
    expect(page.getByTestId('call-device-audiooutput').elements()).toHaveLength(0)
    await expect.element(page.getByTestId('call-device-audioinput')).toBeInTheDocument()
  })

  it('a device that does not switch says why and shows the one still in use', async () => {
    const room = new FakeRoom()
    room.switchFailure.videoinput = 'Could not start video source'
    setup({ room })
    await connected()
    await page.getByTestId('call-devices-toggle').click()
    await page.getByTestId('call-device-videoinput').selectOptions('cam-2')
    await expect.element(page.getByTestId('call-device-problem')).toHaveTextContent(/Desk camera.*Could not start video source/)
    await expect.element(page.getByTestId('call-device-videoinput')).toHaveValue('cam-1')
  })

  it('a device plugged in during the call shows up in the list', async () => {
    const { env } = setup()
    await connected()
    await page.getByTestId('call-devices-toggle').click()
    env.media.change([...env.media.list, { kind: 'audioinput', deviceId: 'mic-new', label: 'Conference mic' }])
    await vi.waitFor(() => expect((page.getByTestId('call-device-audioinput').element() as HTMLSelectElement).options).toHaveLength(3))
  })
})

describe('mini-call.svelte (docked on other pages)', () => {
  function dock(active: ActiveCall, opts: { hidden?: boolean; live?: LiveCalls } = {}) {
    const onopen = vi.fn()
    const live = opts.live ?? new LiveCalls()
    const r = render(MiniCall, { active, live, hidden: opts.hidden ?? false, onopen })
    return { onopen, live, r }
  }

  async function inCall(over: Partial<CallDto> = {}) {
    const l = liveCall()
    l.active.open(fakeCall(over), 'ann')
    await vi.waitFor(() => expect(l.active.state.camera).toBe(true))
    return l
  }

  it('nothing shown without a call, nor on the call page itself', async () => {
    const { active } = liveCall()
    dock(active)
    expect(page.getByTestId('mini-call').elements()).toHaveLength(0)
    const l = await inCall()
    dock(l.active, { hidden: true })
    expect(page.getByTestId('mini-call').elements()).toHaveLength(0)
  })

  it('shows who is in it and how long it runs; Back to call opens the call', async () => {
    const { active, room } = await inCall()
    const live = new LiveCalls()
    live.apply('call.state', fakeCall({ state: 'active', answeredAt: new Date(Date.now() - 65_000).toISOString(), ringUntil: new Date(Date.now() + 1000).toISOString() }))
    room.remote = [remotePerson()]
    room.emit({ type: 'participants' })
    const { onopen } = dock(active, { live })
    const mini = page.getByTestId('mini-call')
    await expect.element(mini.getByTestId('mini-call-title')).toHaveTextContent('Ann Example, Ben Example')
    await expect.element(mini.getByTestId('mini-call-who')).toHaveTextContent('Ben Example')
    await expect.element(mini.getByTestId('mini-call-people')).toHaveAttribute('data-count', '2')
    await expect.element(mini.getByTestId('mini-call-status')).toHaveTextContent(/^1:0\d$/)
    await mini.getByTestId('mini-call-back').click()
    expect(onopen).toHaveBeenCalledExactlyOnceWith('call-1')
  })

  it('alone in the call: waiting for others', async () => {
    const { active } = await inCall()
    dock(active)
    await expect.element(page.getByTestId('mini-call-status')).toHaveTextContent('Waiting for others…')
    await expect.element(page.getByTestId('mini-call-who')).toHaveTextContent('Only you')
  })

  it('mute and camera drive the room; hang up ends the call and the dock goes', async () => {
    const { active, room, client } = await inCall()
    dock(active)
    await page.getByTestId('mini-call-mic').click()
    expect(room.devices.microphone).toBe(false)
    await expect.element(page.getByTestId('mini-call-mic')).toHaveAttribute('data-on', 'false')
    await page.getByTestId('mini-call-camera').click()
    expect(room.devices.camera).toBe(false)
    await page.getByTestId('mini-call-hangup').click()
    await expect.element(page.getByTestId('mini-call')).not.toBeInTheDocument()
    expect(client.hangup).toHaveBeenCalledExactlyOnceWith('call-1', { keepalive: false })
    expect(room.disconnects).toBe(1)
    expect(active.call).toBeNull()
  })

  it('the device picker opens from the dock too', async () => {
    const { active, room } = await inCall()
    dock(active)
    await page.getByTestId('mini-call-devices-toggle').click()
    await page.getByTestId('call-device-audioinput').selectOptions('mic-usb')
    await vi.waitFor(() => expect(room.switches).toEqual([['audioinput', 'mic-usb']]))
  })

  it('the call ending while I am elsewhere: the dock says so until dismissed', async () => {
    const { active, room } = await inCall()
    dock(active)
    room.emit({ type: 'disconnected', reason: 'call_over' })
    await expect.element(page.getByTestId('mini-call-ended')).toHaveTextContent('The call has ended.')
    await page.getByTestId('mini-call-dismiss').click()
    await expect.element(page.getByTestId('mini-call')).not.toBeInTheDocument()
  })

  it('a lost connection: Rejoin from the dock', async () => {
    const { active, room, client } = await inCall()
    dock(active)
    room.emit({ type: 'disconnected', reason: 'connection_lost' })
    await page.getByTestId('mini-call-rejoin').click()
    await expect.element(page.getByTestId('mini-call')).toHaveAttribute('data-phase', 'connected')
    expect(client.token).toHaveBeenCalledTimes(2)
  })
})
