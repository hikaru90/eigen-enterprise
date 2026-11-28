import { describe, expect, it, vi } from 'vitest'
import type { SlotTarget } from './slots'
import { detectImageMime, isPdfBytes, llmLookAt, resolveVisionModel, VisionReadError, type VisionDeps } from './vision'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])

function target(model: string | null, pool: 'openrouter' | 'opper' | null): SlotTarget {
  return {
    slot: 'chat',
    source: 'eigeninference',
    config: { provider: pool ? 'platform' : 'eurouter', baseUrl: 'https://x', apiKey: 'k', ruleChat: null, ruleEmbedding: null, modelChat: null, modelEmbedding: null },
    model,
    pool,
    route: model,
  }
}

function deps(t: SlotTarget, content: unknown = 'A red logo with the word Kindred.', finish = 'stop'): VisionDeps & { complete: ReturnType<typeof vi.fn> } {
  return {
    resolveChat: async () => t,
    complete: vi.fn(async () => ({ choices: [{ message: { content }, finish_reason: finish }] })),
  }
}

describe('vision', () => {
  it('detects images by signature, never by name', () => {
    expect(detectImageMime(PNG)).toBe('image/png')
    expect(detectImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(detectImageMime(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(detectImageMime(new TextEncoder().encode('hello world'))).toBeNull()
    expect(isPdfBytes(new TextEncoder().encode('%PDF-1.7'))).toBe(true)
  })

  it('a text-only chat model hands images to the vision pick; a seeing one keeps them', async () => {
    expect(await resolveVisionModel('u1', deps(target('~deepseek/deepseek-flash-latest', 'opper')))).toBe('google/gemini-3.8-flash')
    expect(await resolveVisionModel('u1', deps(target('openai/gpt-5-mini', 'openrouter')))).toBe('openai/gpt-5-mini')
    expect(await resolveVisionModel('u1', deps(target(null, null)))).toBeUndefined()
  })

  it('sends the image on the user message to the vision model, under the caller task', async () => {
    const d = deps(target('~deepseek/deepseek-flash-latest', 'openrouter'))
    const out = await llmLookAt(
      { userId: 'u1', task: 'drive.image_read', name: 'logo.png', attachment: { type: 'image', mime: 'image/png', base64: 'AAA' }, question: 'What colour?' },
      d,
    )
    expect(out).toEqual({ text: 'A red logo with the word Kindred.', model: 'google/gemini-3.8-flash' })
    const call = d.complete.mock.calls[0]![0]
    expect(call.task).toBe('drive.image_read')
    expect(call.modelOverride).toBe('google/gemini-3.8-flash')
    expect(call.messages[1].attachments).toEqual([{ type: 'image', mime: 'image/png', base64: 'AAA' }])
    expect(call.messages[1].content).toContain('What colour?')
  })

  it('fails loud on an empty or cut-short look', async () => {
    const a = { type: 'image', mime: 'image/png', base64: 'AAA' } as const
    await expect(llmLookAt({ userId: 'u', task: 'web.image_read', name: 'x.png', attachment: a }, deps(target(null, null), '  '))).rejects.toBeInstanceOf(VisionReadError)
    await expect(llmLookAt({ userId: 'u', task: 'web.image_read', name: 'x.png', attachment: a }, deps(target(null, null), 'x', 'length'))).rejects.toBeInstanceOf(VisionReadError)
  })
})
