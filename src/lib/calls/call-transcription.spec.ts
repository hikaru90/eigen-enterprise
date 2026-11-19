import type { CallDto } from './client'
import { describe, expect, it, vi } from 'vitest'
import { ActiveCall } from './active-call.svelte'
import { CallTranscription, type ChunkRecorder } from './call-transcription.svelte'
import { CallRequestError } from './client'
import { FakeRoom, fakeCall, fakeEnv, fakeToken } from './fake-room'

/**
 * My own microphone in ~30 s chunks while I am in the call with the mic on and
 * my transcription on — never otherwise. Timers and the recorder are fakes:
 * no real audio, no server.
 */

const CHUNK = 30_000

/** A call where both are transcribed by default; `meOn: false` = I turned mine off earlier (a rejoin keeps it). */
const callWith = (opts: { meOn?: boolean; benOn?: boolean; benIn?: boolean } = {}): CallDto =>
  fakeCall({
    state: 'active',
    answeredAt: '2026-11-11T09:00:05.000Z',
    participants: [
      { userId: 'ben', name: 'Ben Example', guest: false, response: 'accepted', joinedAt: '2026-11-11T09:00:00.000Z', leftAt: null, inRoom: opts.benIn ?? true, transcribing: opts.benOn ?? true },
      { userId: 'ann', name: 'Ann Example', guest: false, response: 'accepted', joinedAt: '2026-11-11T09:00:05.000Z', leftAt: null, inRoom: true, transcribing: opts.meOn ?? true },
    ],
  })

function setup(opts: { call?: CallDto; speech?: (clip: Blob) => boolean; transcribe?: () => Promise<null> } = {}) {
  const room = new FakeRoom()
  const call = opts.call ?? callWith()
  let t = 1_000_000
  const timers: { fn: () => void; at: number; id: number }[] = []
  let nextId = 0
  const clock = {
    now: () => t,
    /** Moves time on and fires every timer that is due. */
    async tick(ms: number) {
      t += ms
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.at > t) continue
        timers.splice(timers.indexOf(timer), 1)
        timer.fn()
      }
      await flush()
    },
  }
  const recorders: { track: MediaStreamTrack; stopped: boolean; clip: Blob }[] = []
  const record = (track: MediaStreamTrack): ChunkRecorder => {
    const r = { track, stopped: false, clip: new Blob([`chunk-${recorders.length + 1}`], { type: 'audio/webm' }) }
    recorders.push(r)
    return {
      async stop() {
        r.stopped = true
        return r.clip
      },
    }
  }
  const client = {
    accept: vi.fn(async () => call),
    token: vi.fn(async () => fakeToken),
    hangup: vi.fn(async () => ({ ...call, state: 'ended' as const })),
    get: vi.fn(async () => call),
    transcribe: vi.fn(opts.transcribe ?? (async () => null)),
    setTranscription: vi.fn(async (_id: string, on: boolean) => ({
      ...call,
      participants: call.participants.map((p) => (p.userId === 'ann' ? { ...p, transcribing: on } : p)),
    })),
  }
  const active = new ActiveCall({ client, createRoom: async () => room, env: () => fakeEnv() })
  const transcription = new CallTranscription({
    active,
    me: 'ann',
    client,
    record,
    hasSpeech: async (clip) => (opts.speech ? opts.speech(clip) : true),
    chunkMs: CHUNK,
    now: clock.now,
    setTimer: (fn, ms) => {
      const id = ++nextId
      timers.push({ fn, at: t + ms, id })
      return id
    },
    clearTimer: (id) => {
      const i = timers.findIndex((x) => x.id === id)
      if (i >= 0) timers.splice(i, 1)
    },
  })
  return { room, active, client, transcription, recorders, clock, timers, call }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

async function inCall(s: ReturnType<typeof setup>) {
  s.transcription.connect()
  s.active.open(s.call, 'ann')
  await vi.waitFor(() => expect(s.active.state.camera).toBe(true))
  await flush()
}

const sentText = async (s: ReturnType<typeof setup>) => Promise.all(s.client.transcribe.mock.calls.map(async ([, clip, ms]) => [await clip.text(), ms]))

describe('CallTranscription', () => {
  it('records my microphone once I am in with the mic on; every 30 s one chunk goes up with its length', async () => {
    const s = setup()
    await inCall(s)
    expect(s.transcription.recording).toBe(true)
    expect(s.recorders).toHaveLength(1)
    expect(s.recorders[0]!.track).toBe(s.room.micTrack)
    await s.clock.tick(CHUNK)
    await vi.waitFor(() => expect(s.client.transcribe).toHaveBeenCalledOnce())
    expect(await sentText(s)).toEqual([['chunk-1', CHUNK]])
    expect(s.client.transcribe.mock.calls[0]![0]).toBe('call-1')
    // The next chunk started right away.
    expect(s.recorders).toHaveLength(2)
    expect(s.recorders[0]!.stopped).toBe(true)
    expect(s.recorders[1]!.stopped).toBe(false)
  })

  it('a chunk without speech-level sound is never sent', async () => {
    const s = setup({ speech: () => false })
    await inCall(s)
    await s.clock.tick(CHUNK)
    expect(s.recorders).toHaveLength(2)
    expect(s.client.transcribe).not.toHaveBeenCalled()
  })

  it('muting stops recording and sends what was said before; unmuting records again', async () => {
    const s = setup()
    await inCall(s)
    await s.clock.tick(12_000)
    await s.active.turn('microphone', false)
    await flush()
    expect(s.transcription.recording).toBe(false)
    await vi.waitFor(() => expect(s.client.transcribe).toHaveBeenCalledOnce())
    expect(await sentText(s)).toEqual([['chunk-1', 12_000]])
    expect(s.timers).toEqual([])
    await s.active.turn('microphone', true)
    await flush()
    expect(s.transcription.recording).toBe(true)
    expect(s.recorders).toHaveLength(2)
  })

  it('turning my transcription off stops at once and drops the chunk in progress; the server is told', async () => {
    const s = setup()
    await inCall(s)
    await s.clock.tick(10_000)
    await s.transcription.toggle()
    expect(s.transcription.on).toBe(false)
    expect(s.transcription.recording).toBe(false)
    expect(s.recorders[0]!.stopped).toBe(true)
    expect(s.client.setTranscription).toHaveBeenCalledWith('call-1', false)
    expect(s.active.call?.participants.find((p) => p.userId === 'ann')?.transcribing).toBe(false)
    await s.clock.tick(CHUNK)
    expect(s.client.transcribe).not.toHaveBeenCalled()
    await s.transcription.toggle()
    expect(s.client.setTranscription).toHaveBeenLastCalledWith('call-1', true)
    expect(s.transcription.recording).toBe(true)
  })

  it('my earlier choice holds: off in the call → nothing is recorded on joining', async () => {
    const s = setup({ call: callWith({ meOn: false }) })
    await inCall(s)
    expect(s.transcription.on).toBe(false)
    expect(s.transcription.recording).toBe(false)
    expect(s.recorders).toEqual([])
  })

  it('the indicator: someone in the room is transcribed (even when I am not); nobody → off', async () => {
    const s = setup({ call: callWith({ meOn: false }) })
    await inCall(s)
    expect(s.transcription.anyone).toBe(true)
    expect(s.transcription.transcribed).toEqual(['Ben Example'])
    s.active.update(callWith({ meOn: false, benOn: false }))
    expect(s.transcription.anyone).toBe(false)
    s.active.update(callWith({ meOn: false, benOn: true, benIn: false }))
    expect(s.transcription.anyone).toBe(false)
  })

  it('no speech to text on this server: says so once and stops recording (the call goes on)', async () => {
    const s = setup({
      transcribe: async () => {
        throw new CallRequestError({ kind: 'unavailable', message: 'The owner sets up an OpenRouter key for speech' })
      },
    })
    await inCall(s)
    await s.clock.tick(CHUNK)
    await vi.waitFor(() => expect(s.transcription.unavailable).toBe(true))
    expect(s.transcription.problem).toBe('The owner sets up an OpenRouter key for speech')
    expect(s.transcription.recording).toBe(false)
    const made = s.recorders.length
    await s.clock.tick(CHUNK)
    expect(s.recorders).toHaveLength(made)
    expect(s.active.state.phase).toBe('connected')
  })

  it('a chunk that failed to upload is reported; recording goes on', async () => {
    const s = setup({
      transcribe: async () => {
        throw new CallRequestError({ kind: 'failed', message: 'speech to text failed: 502' })
      },
    })
    await inCall(s)
    await s.clock.tick(CHUNK)
    await vi.waitFor(() => expect(s.transcription.problem).toMatch(/speech to text failed: 502/))
    expect(s.transcription.recording).toBe(true)
    s.transcription.dismissProblem()
    expect(s.transcription.problem).toBeNull()
  })

  it('hanging up sends the last partial chunk and records no more; close stops listening', async () => {
    const s = setup()
    await inCall(s)
    await s.clock.tick(5_000)
    await s.active.hangUp()
    await flush()
    expect(s.transcription.recording).toBe(false)
    await vi.waitFor(() => expect(s.client.transcribe).toHaveBeenCalledOnce())
    expect(await sentText(s)).toEqual([['chunk-1', 5_000]])
    s.transcription.close()
    expect(s.timers).toEqual([])
  })
})
