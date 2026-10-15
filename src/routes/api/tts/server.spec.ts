import { beforeEach, describe, expect, it, vi } from 'vitest'

const { synthesizeSpeechMock } = vi.hoisted(() => ({
  synthesizeSpeechMock: vi.fn(),
}))

vi.mock('$lib/server/llm/tts-client', () => ({
  synthesizeSpeech: synthesizeSpeechMock,
}))

import { POST } from './+server'

function jsonRequest(body: unknown): {
  locals: { user?: { id: string } }
  request: { json: () => Promise<unknown> }
} {
  return { locals: { user: { id: 'u1' } }, request: { json: async () => body } }
}

describe('POST /api/tts', () => {
  beforeEach(() => {
    synthesizeSpeechMock.mockReset()
  })

  it('requires a signed-in user', async () => {
    await expect(
      POST({ locals: {}, request: { json: async () => ({ text: 'hi' }) } } as never),
    ).rejects.toMatchObject({ status: 401 })
    expect(synthesizeSpeechMock).not.toHaveBeenCalled()
  })

  it('fails loud on empty text', async () => {
    await expect(POST(jsonRequest({ text: '  ' }) as never)).rejects.toMatchObject({
      status: 400,
    })
    expect(synthesizeSpeechMock).not.toHaveBeenCalled()
  })

  it('fails loud on oversized text', async () => {
    await expect(POST(jsonRequest({ text: 'a'.repeat(4001) }) as never)).rejects.toMatchObject({
      status: 400,
    })
    expect(synthesizeSpeechMock).not.toHaveBeenCalled()
  })

  it('returns the gateway audio bytes as mp3', async () => {
    synthesizeSpeechMock.mockResolvedValue(new Uint8Array([1, 2, 3, 4]))
    const res = await POST(jsonRequest({ text: 'You talk. It builds.' }) as never)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(synthesizeSpeechMock).toHaveBeenCalledWith({ userId: 'u1', text: 'You talk. It builds.' })
  })

  it('maps gateway failures to a 500 with the provider message', async () => {
    synthesizeSpeechMock.mockRejectedValue(new Error('LLM TTS HTTP 401: bad key'))
    const res = await POST(jsonRequest({ text: 'hello' }) as never)
    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toMatchObject({ error: 'LLM TTS HTTP 401: bad key' })
  })
})
