import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendVoiceTranscript,
  parseTranscribeErrorResponse,
  transcribeVoiceClip,
  TranscribeRequestError,
  VOICE_TRANSCRIBE_URL,
} from './transcribe-voice-clip'

const lastInit = () => vi.mocked(fetch).mock.calls[0]![1] as RequestInit

describe('appendVoiceTranscript', () => {
  it('appends to the draft with one space, never overwriting typed text', () => {
    expect(appendVoiceTranscript('Foo   ', '   bar')).toBe('Foo bar')
    expect(appendVoiceTranscript('', 'bar')).toBe('bar')
    expect(appendVoiceTranscript('Foo', '  ')).toBe('Foo')
  })
})

describe('parseTranscribeErrorResponse', () => {
  it('reads the json error, else the text, else a status line', async () => {
    await expect(parseTranscribeErrorResponse(new Response(JSON.stringify({ error: 'down' }), { status: 502 }))).resolves.toBe('down')
    await expect(parseTranscribeErrorResponse(new Response(JSON.stringify({ message: 'too big' }), { status: 400 }))).resolves.toBe('too big')
    await expect(parseTranscribeErrorResponse(new Response('bad gateway', { status: 502 }))).resolves.toBe('bad gateway')
    await expect(parseTranscribeErrorResponse(new Response('', { status: 503 }))).resolves.toBe('Transcription failed (503)')
  })
})

describe('transcribeVoiceClip', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ transcript: ' hello there ' }))))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('posts the whole clip once as a raw audio body (CSRF-exempt), no language hint', async () => {
    const clip = new Blob([new Uint8Array([1, 2])], { type: 'audio/webm;codecs=opus' })
    await expect(transcribeVoiceClip(clip)).resolves.toBe('hello there')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(VOICE_TRANSCRIBE_URL)
    const init = lastInit()
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('same-origin')
    expect(init.body).toBe(clip)
    expect([...new Headers(init.headers).keys()]).toEqual(['content-type'])
    expect(new Headers(init.headers).get('content-type')).toBe('audio/webm;codecs=opus')
  })

  it('passes the abort signal on', async () => {
    const controller = new AbortController()
    await transcribeVoiceClip(new Blob(['x'], { type: 'audio/webm' }), { signal: controller.signal })
    expect(lastInit().signal).toBe(controller.signal)
  })

  it('throws TranscribeRequestError with the status and the server message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'no provider' }), { status: 503 })))
    const err = await transcribeVoiceClip(new Blob(['x'], { type: 'audio/webm' })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TranscribeRequestError)
    expect(err).toMatchObject({ status: 503, message: 'no provider' })
  })

  it('throws when the transcript field is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}))))
    await expect(transcribeVoiceClip(new Blob(['x'], { type: 'audio/webm' }))).rejects.toThrow(/missing transcript/i)
  })

  it('returns "" for a blank transcript: no speech is a valid answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ transcript: '  ' }))))
    await expect(transcribeVoiceClip(new Blob(['x'], { type: 'audio/webm' }))).resolves.toBe('')
  })
})
