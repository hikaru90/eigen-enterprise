import { afterEach, describe, expect, it, vi } from 'vitest'
import { uploadVoiceRecording, voiceFileName } from './voice-upload'

/** The composer's dictated recording, uploaded as it was recorded to be sent with its transcript. */

describe('voiceFileName', () => {
  const at = new Date(2026, 10, 19, 14, 3, 7)
  it('names the recording by when it was made, with its container’s extension', () => {
    expect(voiceFileName('audio/webm;codecs=opus', at)).toBe(
      'Voice message 2026-11-19 14.03.07.webm',
    )
    expect(voiceFileName('audio/mp4', at)).toBe('Voice message 2026-11-19 14.03.07.m4a')
    expect(voiceFileName('audio/ogg;codecs=opus', at)).toBe('Voice message 2026-11-19 14.03.07.ogg')
  })
  it('refuses a recording of no known container (it could not be played back)', () => {
    expect(() => voiceFileName('', at)).toThrow(/audio format/)
    expect(() => voiceFileName('video/x-unknown', at)).toThrow(/audio format/)
  })
})

describe('uploadVoiceRecording', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uploads the clip unchanged into the conversation and returns the uploaded file', async () => {
    const uploaded = {
      fileId: 'f1',
      name: 'Voice message 2026-11-19 14.03.07.webm',
      mime: 'audio/webm;codecs=opus',
      size: 3,
      image: false,
    }
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ uploaded: [uploaded], errors: [] }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const clip = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm;codecs=opus' })
    const file = await uploadVoiceRecording('c1', clip, new Date(2026, 10, 19, 14, 3, 7))
    expect(file).toEqual(uploaded)
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit]
    expect(url).toBe('/api/messages/conversations/c1/attachments')
    expect(init.method).toBe('POST')
    const sent = (init.body as FormData).get('file') as File
    expect(sent.name).toBe('Voice message 2026-11-19 14.03.07.webm')
    expect(sent.type).toBe('audio/webm;codecs=opus')
    expect([...new Uint8Array(await sent.arrayBuffer())]).toEqual([1, 2, 3])
  })

  it('fails loud with the server’s words: an error status, or the file refused', async () => {
    const clip = new Blob([new Uint8Array([1])], { type: 'audio/webm' })
    const agent = {
      attempted: 'Uploading attachments (/api/messages)',
      nextSteps: ['Read the journal.'],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'conversation not found', agent }), { status: 404 }),
      ),
    )
    await expect(uploadVoiceRecording('c1', clip)).rejects.toThrow('conversation not found')
    await expect(uploadVoiceRecording('c1', clip)).rejects.toMatchObject({
      shown: { error: 'conversation not found', agent },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ uploaded: [], errors: ['“Voice message.webm” is too large'] }),
            { status: 200 },
          ),
      ),
    )
    await expect(uploadVoiceRecording('c1', clip)).rejects.toThrow('is too large')
  })
})
