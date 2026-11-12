import { describe, expect, it, vi } from 'vitest'
import { ActiveCall, type CallEnv } from './active-call.svelte'
import { CallRequestError } from './client'
import { DEVICES_KEY } from './devices'
import { FakeRoom, fakeCall, fakeEnv, fakeToken, memoryStorage, remotePerson } from './fake-room'

function setup(opts: { room?: FakeRoom; env?: Partial<CallEnv>; token?: () => Promise<typeof fakeToken> } = {}) {
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

const connected = (active: ActiveCall) => vi.waitFor(() => expect(active.state.phase).toBe('connected'))
const settled = (active: ActiveCall) => vi.waitFor(() => expect(active.state.camera).toBe(true))

describe('ActiveCall: one live call above the pages', () => {
  it('open joins: accepts when I have not, takes a token, connects, turns mic + camera on', async () => {
    const { active, room, client } = setup()
    expect(active.open(fakeCall({}, 'none'), 'ann')).toBe('joining')
    expect(active.inCall).toBe(true)
    await settled(active)
    expect(client.accept).toHaveBeenCalledWith('call-1')
    expect(client.token).toHaveBeenCalledWith('call-1')
    expect(room.connectedWith).toEqual(['wss://rtc.example.test', 'tok'])
    expect(active.state.mic).toBe(true)
    expect(active.call?.id).toBe('call-1')
    expect(active.participants.map((p) => p.identity)).toEqual(['ann'])
  })

  it('opening the same call again only shows it (no second join)', async () => {
    const { active, client, createRoom } = setup()
    active.open(fakeCall(), 'ann')
    await settled(active)
    expect(active.open(fakeCall(), 'ann')).toBe('here')
    expect(client.token).toHaveBeenCalledOnce()
    expect(createRoom).toHaveBeenCalledOnce()
  })

  it('opening another call while in one is refused: I am already in a call', async () => {
    const { active, client } = setup()
    active.open(fakeCall(), 'ann')
    await settled(active)
    expect(active.open(fakeCall({ id: 'call-2', title: 'Standup' }), 'ann')).toBe('busy')
    expect(active.call?.id).toBe('call-1')
    expect(active.state.phase).toBe('connected')
    expect(client.token).toHaveBeenCalledOnce()
  })

  it('hang up: leaves the room, tells the server once, stops listening; release forgets the call', async () => {
    const { active, room, client, env } = setup()
    active.open(fakeCall(), 'ann')
    await settled(active)
    expect(env.win.listening).toBe(1)
    expect(env.media.listening).toBe(1)
    await active.hangUp()
    expect(room.disconnects).toBe(1)
    expect(client.hangup).toHaveBeenCalledExactlyOnceWith('call-1', { keepalive: false })
    expect(active.state.phase).toBe('ended')
    expect(active.state.ended).toBe('hung_up')
    expect(active.inCall).toBe(false)
    expect(env.win.listening).toBe(0)
    expect(env.media.listening).toBe(0)
    await active.hangUp()
    expect(client.hangup).toHaveBeenCalledOnce()
    active.release()
    expect(active.call).toBeNull()
  })

  it('release while still in the call keeps it (only a call that is over is forgotten)', async () => {
    const { active } = setup()
    active.open(fakeCall(), 'ann')
    await settled(active)
    active.release()
    expect(active.call?.id).toBe('call-1')
    expect(active.inCall).toBe(true)
  })

  it('closing or leaving the tab (pagehide) hangs up with keepalive', async () => {
    const { active, room, client, env } = setup()
    active.open(fakeCall(), 'ann')
    await settled(active)
    env.win.pagehide()
    await vi.waitFor(() => expect(client.hangup).toHaveBeenCalledExactlyOnceWith('call-1', { keepalive: true }))
    expect(room.disconnects).toBe(1)
  })

  it('close (the nucleus layout goes away) hangs up with keepalive', async () => {
    const { active, client } = setup()
    active.open(fakeCall(), 'ann')
    await settled(active)
    active.close()
    await vi.waitFor(() => expect(client.hangup).toHaveBeenCalledExactlyOnceWith('call-1', { keepalive: true }))
  })

  it('hanging up while still connecting never ends up in the room', async () => {
    let let_go = () => {}
    const room = new FakeRoom()
    room.holdConnect = new Promise<void>((r) => (let_go = r))
    const { active, client } = setup({ room })
    active.open(fakeCall(), 'ann')
    // The room exists and connect() is in flight.
    await vi.waitFor(() => expect(room.listening).toBe(1))
    await active.hangUp()
    let_go()
    await vi.waitFor(() => expect(room.disconnects).toBeGreaterThanOrEqual(1))
    expect(active.state.phase).toBe('ended')
    expect(room.devices.microphone).toBe(false)
    expect(client.hangup).toHaveBeenCalledOnce()
  })

  it('the call closing on the server: ended (call_over) with how it ended', async () => {
    const { active, room, client } = setup()
    active.open(fakeCall(), 'ann')
    await settled(active)
    room.emit({ type: 'disconnected', reason: 'call_over' })
    expect(active.state.ended).toBe('call_over')
    expect(active.inCall).toBe(false)
    await vi.waitFor(() => expect(active.finalState).toBe('missed'))
    expect(client.get).toHaveBeenCalledWith('call-1')
    expect(client.hangup).not.toHaveBeenCalled()
  })

  it('a lost connection can be rejoined', async () => {
    const { active, room, client } = setup()
    active.open(fakeCall(), 'ann')
    await settled(active)
    room.emit({ type: 'disconnected', reason: 'connection_lost' })
    active.rejoin()
    await connected(active)
    expect(client.token).toHaveBeenCalledTimes(2)
  })

  it('after a call is over, opening another one joins it', async () => {
    const rooms = [new FakeRoom(), new FakeRoom()]
    const { active, client, createRoom } = setup()
    createRoom.mockImplementation(async () => rooms.shift()!)
    active.open(fakeCall(), 'ann')
    await settled(active)
    await active.hangUp()
    expect(active.open(fakeCall({ id: 'call-2' }), 'ann')).toBe('joining')
    await settled(active)
    expect(active.call?.id).toBe('call-2')
    expect(client.token).toHaveBeenLastCalledWith('call-2')
  })

  it('calls not set up: the problem, no room', async () => {
    const { active, createRoom } = setup({
      token: async () => {
        throw new CallRequestError({ kind: 'not_configured', message: 'Calls are not set up on this server' })
      },
    })
    active.open(fakeCall(), 'ann')
    await vi.waitFor(() => expect(active.state.phase).toBe('error'))
    expect(active.state.problem?.kind).toBe('not_configured')
    expect(createRoom).not.toHaveBeenCalled()
  })

  it('the room failing to load is a problem the person reads (no silent failure)', async () => {
    const { active, createRoom } = setup()
    createRoom.mockRejectedValueOnce(new Error('chunk failed'))
    active.open(fakeCall(), 'ann')
    await vi.waitFor(() => expect(active.state.phase).toBe('error'))
    expect(active.state.problem?.message).toMatch(/chunk failed/)
  })

  it('the active speaker: the remote person speaking, kept through a pause', async () => {
    const { active, room } = setup()
    active.open(fakeCall(), 'ann')
    await settled(active)
    room.remote = [remotePerson(), remotePerson({ identity: 'cy', name: 'Cy', speaking: true })]
    room.emit({ type: 'participants' })
    expect(active.speaker).toBe('cy')
    room.remote = [remotePerson(), remotePerson({ identity: 'cy', name: 'Cy' })]
    room.emit({ type: 'participants' })
    expect(active.speaker).toBe('cy')
  })
})

describe('ActiveCall: choosing devices', () => {
  it('lists microphones, speakers and cameras once in the call; refreshes when devices change', async () => {
    const { active, env } = setup()
    active.open(fakeCall(), 'ann')
    await settled(active)
    expect(active.devices.audioinput.map((d) => d.id)).toEqual(['default', 'mic-usb'])
    expect(active.devices.audiooutput.map((d) => d.id)).toEqual(['default', 'spk-usb'])
    expect(active.devices.videoinput.map((d) => d.id)).toEqual(['cam-1', 'cam-2'])
    env.media.change([{ kind: 'audioinput', deviceId: 'mic-new', label: 'New mic' }])
    await vi.waitFor(() => expect(active.devices.audioinput.map((d) => d.id)).toEqual(['mic-new']))
    expect(active.devices.videoinput).toEqual([])
  })

  it('choosing a device switches the room to it and remembers it for this browser', async () => {
    const storage = memoryStorage()
    const { active, room } = setup({ env: { storage } })
    active.open(fakeCall(), 'ann')
    await settled(active)
    await active.chooseDevice('audioinput', 'mic-usb')
    await active.chooseDevice('videoinput', 'cam-2')
    await active.chooseDevice('audiooutput', 'spk-usb')
    expect(room.switches).toEqual([
      ['audioinput', 'mic-usb'],
      ['videoinput', 'cam-2'],
      ['audiooutput', 'spk-usb'],
    ])
    expect(active.selected).toEqual({ audioinput: 'mic-usb', videoinput: 'cam-2', audiooutput: 'spk-usb' })
    expect(JSON.parse(storage.data[DEVICES_KEY])).toEqual({ audioinput: 'mic-usb', videoinput: 'cam-2', audiooutput: 'spk-usb' })
  })

  it('the next call starts on the remembered devices (switched before mic and camera turn on)', async () => {
    const storage = memoryStorage({ [DEVICES_KEY]: JSON.stringify({ audioinput: 'mic-usb', videoinput: 'cam-2', audiooutput: 'spk-usb' }) })
    const room = new FakeRoom()
    const order: string[] = []
    const switchDevice = room.switchDevice.bind(room)
    room.switchDevice = async (k, id) => {
      order.push(`switch ${k}`)
      await switchDevice(k, id)
    }
    const setDevice = room.setDevice.bind(room)
    room.setDevice = async (d, on) => {
      order.push(`${d} ${on}`)
      await setDevice(d, on)
    }
    const { active } = setup({ room, env: { storage } })
    active.open(fakeCall(), 'ann')
    await settled(active)
    expect(order).toEqual(['switch audioinput', 'switch audiooutput', 'switch videoinput', 'microphone true', 'camera true'])
    expect(active.selected).toEqual({ audioinput: 'mic-usb', videoinput: 'cam-2', audiooutput: 'spk-usb' })
  })

  it('a remembered device that is not plugged in is not used', async () => {
    const storage = memoryStorage({ [DEVICES_KEY]: JSON.stringify({ audioinput: 'mic-gone' }) })
    const { active, room } = setup({ env: { storage } })
    active.open(fakeCall(), 'ann')
    await settled(active)
    expect(room.switches).toEqual([])
    expect(active.selected.audioinput).toBe('default')
  })

  it('a device that does not switch says so and keeps the previous one', async () => {
    const room = new FakeRoom()
    room.switchFailure.videoinput = 'Could not start video source'
    const { active } = setup({ room })
    active.open(fakeCall(), 'ann')
    await settled(active)
    await active.chooseDevice('videoinput', 'cam-2')
    expect(active.deviceProblem).toMatch(/Desk camera.*Could not start video source/)
    expect(active.selected.videoinput).toBe('cam-1')
    active.dismissDeviceProblem()
    expect(active.deviceProblem).toBeNull()
  })

  it('a browser that cannot choose the speaker: no switch is attempted, a remembered speaker is not applied', async () => {
    const storage = memoryStorage({ [DEVICES_KEY]: JSON.stringify({ audiooutput: 'spk-usb' }) })
    const { active, room } = setup({ env: { storage, canChooseSpeaker: false } })
    active.open(fakeCall(), 'ann')
    await settled(active)
    expect(active.canChooseSpeaker).toBe(false)
    await active.chooseDevice('audiooutput', 'spk-usb')
    expect(room.switches).toEqual([])
  })
})
