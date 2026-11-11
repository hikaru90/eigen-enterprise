import { describe, expect, it } from 'vitest'
import { callReducer, initialCallState, problemFromResponse, tilesOf, type CallParticipant } from './call-state'

const run = (...events: Parameters<typeof callReducer>[1][]) => events.reduce(callReducer, initialCallState)

describe('callReducer', () => {
  it('starts connecting with everything off', () => {
    expect(initialCallState).toEqual({ phase: 'connecting', problem: null, ended: null, mic: false, camera: false, screen: false, notices: [] })
  })

  it('connecting → connected → reconnecting → connected', () => {
    expect(run({ type: 'connected' }).phase).toBe('connected')
    expect(run({ type: 'connected' }, { type: 'reconnecting' }).phase).toBe('reconnecting')
    expect(run({ type: 'connected' }, { type: 'reconnecting' }, { type: 'reconnected' }).phase).toBe('connected')
  })

  it('a disconnect ends the call view with its reason; media flags go off', () => {
    const s = run({ type: 'connected' }, { type: 'media', device: 'microphone', on: true }, { type: 'disconnected', reason: 'call_over' })
    expect(s).toMatchObject({ phase: 'ended', ended: 'call_over', mic: false, camera: false, screen: false })
  })

  it('a failure is an error with its problem; retry goes back to connecting', () => {
    const s = run({ type: 'failed', problem: { kind: 'not_configured', message: 'Calls are not set up on this server' } })
    expect(s).toMatchObject({ phase: 'error', problem: { kind: 'not_configured' } })
    expect(callReducer(s, { type: 'retry' })).toEqual(initialCallState)
  })

  it('events after the end change nothing except retry', () => {
    const ended = run({ type: 'connected' }, { type: 'disconnected', reason: 'hung_up' })
    expect(callReducer(ended, { type: 'connected' })).toBe(ended)
    expect(callReducer(ended, { type: 'media', device: 'camera', on: true })).toBe(ended)
  })

  it('mic / camera / screen flags follow media events', () => {
    const s = run(
      { type: 'connected' },
      { type: 'media', device: 'microphone', on: true },
      { type: 'media', device: 'camera', on: true },
      { type: 'media', device: 'screen', on: true },
      { type: 'media', device: 'camera', on: false },
    )
    expect(s).toMatchObject({ mic: true, camera: false, screen: true })
  })

  it('a blocked camera is a notice that says what to do; the call stays connected; turning it on again clears it', () => {
    const s = run({ type: 'connected' }, { type: 'media_failed', device: 'camera', failure: 'permission_denied' })
    expect(s.phase).toBe('connected')
    expect(s.camera).toBe(false)
    expect(s.notices).toEqual([
      { device: 'camera', failure: 'permission_denied', message: expect.stringMatching(/blocked the camera.*Allow camera access/s) },
    ])
    expect(callReducer(s, { type: 'media', device: 'camera', on: true }).notices).toEqual([])
    expect(callReducer(s, { type: 'dismiss_notice', device: 'camera' }).notices).toEqual([])
  })

  it('one notice per device (the newest wins); missing and busy devices say so', () => {
    const s = run(
      { type: 'media_failed', device: 'microphone', failure: 'permission_denied' },
      { type: 'media_failed', device: 'microphone', failure: 'not_found' },
      { type: 'media_failed', device: 'camera', failure: 'in_use' },
    )
    expect(s.notices.map((n) => [n.device, n.failure])).toEqual([
      ['microphone', 'not_found'],
      ['camera', 'in_use'],
    ])
    expect(s.notices[0].message).toMatch(/No microphone found/)
    expect(s.notices[1].message).toMatch(/camera is in use/)
  })
})

describe('problemFromResponse', () => {
  it('maps the server’s error code, never its wording', () => {
    expect(problemFromResponse(503, { code: 'not_configured', error: 'Calls are not set up on this server (missing LIVEKIT_URL)' })).toEqual({
      kind: 'not_configured',
      message: 'Calls are not set up on this server (missing LIVEKIT_URL)',
    })
    expect(problemFromResponse(409, { code: 'conflict', error: 'this call is over' })).toEqual({ kind: 'over', message: 'this call is over' })
    expect(problemFromResponse(404, { code: 'not_found', error: 'call not found' })).toEqual({ kind: 'over', message: 'call not found' })
    expect(problemFromResponse(500, { error: 'boom' })).toEqual({ kind: 'failed', message: 'boom' })
    expect(problemFromResponse(502, {})).toEqual({ kind: 'failed', message: 'request failed (502)' })
  })
})

describe('tilesOf', () => {
  const p = (over: Partial<CallParticipant>): CallParticipant => ({
    identity: 'x',
    name: 'X',
    isLocal: false,
    micOn: true,
    cameraOn: true,
    speaking: false,
    camera: null,
    screen: null,
    ...over,
  })

  it('screen shares first, then you, then everyone else by name', () => {
    const stream = {} as MediaStream
    const tiles = tilesOf([
      p({ identity: 'ben', name: 'Ben' }),
      p({ identity: 'me', name: 'Ann', isLocal: true }),
      p({ identity: 'al', name: 'Al', screen: stream }),
    ])
    expect(tiles.map((t) => t.key)).toEqual(['al:screen', 'me:camera', 'al:camera', 'ben:camera'])
    expect(tiles[0]).toMatchObject({ kind: 'screen', name: 'Al', stream })
  })
})
