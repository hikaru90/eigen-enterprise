import type { CallParticipant, Device, MediaFailure } from './call-state'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import CallView from './call-view.svelte'
import { CallRequestError, type CallDto, type CallTokenDto } from './client'
import { MediaError, type CallRoom, type RoomSignal } from './room'

/** A room with no server: the spec decides who is in it and what the devices do. */
class FakeRoom implements CallRoom {
  connectedWith: [string, string] | null = null
  disconnects = 0
  devices: Record<Device, boolean> = { microphone: false, camera: false, screen: false }
  failures: Partial<Record<Device, MediaFailure>> = {}
  remote: CallParticipant[] = []
  private readonly listeners = new Set<(s: RoomSignal) => void>()
  private readonly cameraStream = new MediaStream()
  private readonly screenStream = new MediaStream()

  async connect(url: string, token: string) {
    this.connectedWith = [url, token]
  }
  async disconnect() {
    this.disconnects++
    this.emit({ type: 'disconnected', reason: 'hung_up' })
  }
  async setDevice(device: Device, on: boolean) {
    const failure = this.failures[device]
    if (on && failure) throw new MediaError(failure, `${device} failed`)
    this.devices[device] = on
    this.emit({ type: 'participants' })
  }
  async startAudio() {}
  participants(): CallParticipant[] {
    const me: CallParticipant = {
      identity: 'ann',
      name: 'Ann Example',
      isLocal: true,
      micOn: this.devices.microphone,
      cameraOn: this.devices.camera,
      speaking: false,
      camera: this.devices.camera ? this.cameraStream : null,
      screen: this.devices.screen ? this.screenStream : null,
    }
    return this.connectedWith ? [me, ...this.remote] : []
  }
  on(fn: (s: RoomSignal) => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  emit(s: RoomSignal) {
    for (const fn of [...this.listeners]) fn(s)
  }
}

const call = (response: 'accepted' | 'none' = 'accepted'): CallDto => ({
  id: 'call-1',
  contextKind: 'dm',
  contextId: 'dm-1',
  title: 'Ann Example, Ben Example',
  startedBy: 'ben',
  startedByName: 'Ben Example',
  state: 'ringing',
  startedAt: '2026-11-11T09:00:00.000Z',
  answeredAt: null,
  endedAt: null,
  ringUntil: '2026-11-11T09:00:45.000Z',
  participants: [
    { userId: 'ben', name: 'Ben Example', response: 'accepted', joinedAt: null, leftAt: null, inRoom: false },
    { userId: 'ann', name: 'Ann Example', response, joinedAt: null, leftAt: null, inRoom: false },
  ],
})

const token: CallTokenDto = { url: 'wss://rtc.example.test', room: 'ee-call-call-1', identity: 'ann', token: 'tok', expiresAt: '2026-11-11T09:10:00.000Z' }

function setup(opts: { response?: 'accepted' | 'none'; token?: () => Promise<CallTokenDto>; room?: FakeRoom } = {}) {
  const room = opts.room ?? new FakeRoom()
  const client = {
    accept: vi.fn(async () => call('accepted')),
    token: vi.fn(opts.token ?? (async () => token)),
    hangup: vi.fn(async () => call()),
    get: vi.fn(async () => ({ ...call(), state: 'missed' as const })),
  }
  const createRoom = vi.fn(() => room)
  const onleave = vi.fn()
  const r = render(CallView, { call: call(opts.response), me: 'ann', client, createRoom, onleave })
  return { room, client, createRoom, onleave, r }
}

const remoteBen = (over: Partial<CallParticipant> = {}): CallParticipant => ({
  identity: 'ben',
  name: 'Ben Example',
  isLocal: false,
  micOn: false,
  cameraOn: true,
  speaking: false,
  camera: new MediaStream(),
  screen: null,
  ...over,
})

describe('call-view.svelte', () => {
  it('accepts when I have not, fetches a token, joins the room, turns mic + camera on', async () => {
    const { room, client } = setup({ response: 'none' })
    await expect.element(page.getByTestId('call-view')).toHaveAttribute('data-phase', 'connected')
    expect(client.accept).toHaveBeenCalledWith('call-1')
    expect(client.token).toHaveBeenCalledWith('call-1')
    expect(room.connectedWith).toEqual(['wss://rtc.example.test', 'tok'])
    await expect.element(page.getByTestId('call-mic')).toHaveAttribute('data-on', 'true')
    await expect.element(page.getByTestId('call-camera')).toHaveAttribute('data-on', 'true')
    const mine = page.getByTestId('call-tile').first()
    await expect.element(mine).toHaveAttribute('data-local', 'true')
    await expect.element(mine).toHaveAttribute('data-video', 'true')
    await expect.element(page.getByTestId('call-status')).toHaveTextContent('Waiting for others to join…')
  })

  it('does not accept again when I already did', async () => {
    const { client } = setup()
    await expect.element(page.getByTestId('call-view')).toHaveAttribute('data-phase', 'connected')
    expect(client.accept).not.toHaveBeenCalled()
  })

  it('shows remote people with their names and a muted indicator', async () => {
    const { room } = setup()
    await expect.element(page.getByTestId('call-view')).toHaveAttribute('data-phase', 'connected')
    room.remote = [remoteBen()]
    room.emit({ type: 'participants' })
    const ben = page.getByTestId('call-tile').nth(1)
    await expect.element(ben).toHaveAttribute('data-identity', 'ben')
    await expect.element(ben).toHaveAttribute('data-muted', 'true')
    await expect.element(ben.getByTestId('call-muted')).toBeInTheDocument()
    await expect.element(ben.getByTestId('call-tile-name')).toHaveTextContent('Ben Example')
    await expect.element(page.getByTestId('call-status')).toHaveTextContent('2 in the call')
    // The video element shows the participant's MediaStream.
    const video = ben.getByTestId('call-video').element() as HTMLVideoElement
    expect(video.srcObject).toBe(room.remote[0].camera)
  })

  it('mute, camera off and screen share drive the room', async () => {
    const { room } = setup()
    await expect.element(page.getByTestId('call-mic')).toHaveAttribute('data-on', 'true')
    await page.getByRole('button', { name: 'Mute' }).click()
    expect(room.devices.microphone).toBe(false)
    await expect.element(page.getByTestId('call-mic')).toHaveAttribute('aria-pressed', 'true')
    await expect.element(page.getByTestId('call-tile').first()).toHaveAttribute('data-muted', 'true')

    await page.getByRole('button', { name: 'Turn camera off' }).click()
    expect(room.devices.camera).toBe(false)
    await expect.element(page.getByTestId('call-tile').first()).toHaveAttribute('data-video', 'false')

    await page.getByRole('button', { name: 'Share screen' }).click()
    expect(room.devices.screen).toBe(true)
    await expect.element(page.getByTestId('call-tile').first()).toHaveAttribute('data-kind', 'screen')
    // The browser's own "Stop sharing" ends it too.
    room.devices.screen = false
    room.emit({ type: 'media', device: 'screen', on: false })
    await expect.element(page.getByRole('button', { name: 'Share screen' })).toBeInTheDocument()
  })

  it('hang up leaves the room, tells the server once, then leaves the page', async () => {
    const { room, client, onleave, r } = setup()
    await expect.element(page.getByTestId('call-view')).toHaveAttribute('data-phase', 'connected')
    await page.getByTestId('call-hangup').click()
    await vi.waitFor(() => expect(onleave).toHaveBeenCalledOnce())
    expect(room.disconnects).toBe(1)
    expect(client.hangup).toHaveBeenCalledExactlyOnceWith('call-1', { keepalive: false })
    r.unmount()
    expect(client.hangup).toHaveBeenCalledOnce()
  })

  it('navigating away (unmount) leaves the room and hangs up with keepalive', async () => {
    const { room, client, r } = setup()
    await expect.element(page.getByTestId('call-view')).toHaveAttribute('data-phase', 'connected')
    r.unmount()
    expect(room.disconnects).toBe(1)
    expect(client.hangup).toHaveBeenCalledExactlyOnceWith('call-1', { keepalive: true })
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
    await expect.element(page.getByTestId('call-view')).toHaveAttribute('data-phase', 'connected')
    await expect.element(page.getByTestId('call-mic')).toHaveAttribute('data-on', 'true')
    await expect.element(page.getByTestId('call-camera')).toHaveAttribute('data-on', 'false')
  })

  it('the call closing on the server ends the view with how it ended', async () => {
    const { room, client } = setup()
    await expect.element(page.getByTestId('call-view')).toHaveAttribute('data-phase', 'connected')
    room.emit({ type: 'disconnected', reason: 'call_over' })
    await expect.element(page.getByTestId('call-ended')).toHaveAttribute('data-reason', 'call_over')
    await expect.element(page.getByTestId('call-ended')).toHaveTextContent('Nobody answered.')
    expect(client.get).toHaveBeenCalledWith('call-1')
  })

  it('a lost connection offers Rejoin, which joins again', async () => {
    const { room, client } = setup()
    await expect.element(page.getByTestId('call-view')).toHaveAttribute('data-phase', 'connected')
    room.emit({ type: 'disconnected', reason: 'connection_lost' })
    await page.getByTestId('call-rejoin').click()
    await expect.element(page.getByTestId('call-view')).toHaveAttribute('data-phase', 'connected')
    expect(client.token).toHaveBeenCalledTimes(2)
  })
})
