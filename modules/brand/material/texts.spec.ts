import { describe, expect, it } from 'vitest'
import { LlmHttpError, LlmNotConfiguredError } from '$lib/server/llm/errors'
import type { ChatMessage } from '$lib/server/llm/llm-client'
import { InMemoryBrandStore } from '../store'
import { MATERIAL_NO_PROVIDER_MESSAGE, MATERIAL_TEXT_LOG_CONTEXT, suggestMaterialTexts, type MaterialChat } from './texts'
import { MATERIAL_COPY_LIMITS } from './types'

function reply(payload: unknown) {
  return { choices: [{ message: { content: typeof payload === 'string' ? payload : JSON.stringify(payload) } }] }
}

const piece = (n: number) => ({ headline: `Headline ${n}`, body: `Body ${n}.`, cta: `Go ${n}` })
const pieces = [piece(1), piece(2), piece(3)]

async function activeVoice(store: InMemoryBrandStore, locale = 'de') {
  const set = await store.createSet({
    locale,
    context: {
      mission: 'Make company operations legible.',
      audience: 'Founders of small companies.',
      register: 'Plain, warm, direct.',
      toneAttributes: ['clear and approachable', 'candid without hype'],
    },
  })
  await store.addVoiceExample({ setId: set.id, contentType: 'social', body: 'Wir zeigen, wie es geht.', label: 'good' })
  await store.addVoiceExample({ setId: set.id, contentType: 'social', body: 'REVOLUTIONÄR!!!', label: 'bad', rationale: 'hype' })
  await store.addLexiconEntry({ setId: set.id, term: 'disruptiv', kind: 'banned', replacement: 'neu' })
  await store.addGlossaryEntry({ setId: set.id, term: 'Nucleus', definition: 'The core app.' })
  await store.activateSet(set.id)
  return set
}

describe('suggestMaterialTexts', () => {
  it('asks the gateway once for three headline / text / button variants, in the active brand voice', async () => {
    const brand = new InMemoryBrandStore()
    await activeVoice(brand)
    const calls: Array<{ messages: ChatMessage[]; logContext?: string; responseFormat?: string; userId: string }> = []
    const chat: MaterialChat = async (input) => {
      calls.push(input)
      return reply({ variants: pieces })
    }
    const out = await suggestMaterialTexts({ brand, chat }, { formatId: 'poster-a1', brief: 'Messe Halle 3, Stand 12', userId: 'ana' })
    expect(out).toEqual({ formatId: 'poster-a1', locale: 'de', voice: true, variants: pieces })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ userId: 'ana', logContext: MATERIAL_TEXT_LOG_CONTEXT, responseFormat: 'json_object' })
    const prompt = calls[0].messages.map((m) => m.content).join('\n')
    for (const text of ['A1 poster', '594 × 841 mm', 'Messe Halle 3, Stand 12', 'Wir zeigen, wie es geht.', 'disruptiv', 'Nucleus', 'candid without hype', `${MATERIAL_COPY_LIMITS.headline}`]) {
      expect(prompt).toContain(text)
    }
  })

  it('merch gets slogans only', async () => {
    const brand = new InMemoryBrandStore()
    const calls: ChatMessage[][] = []
    const chat: MaterialChat = async (input) => {
      calls.push(input.messages)
      return reply({ variants: [{ headline: 'One' }, { headline: 'Two' }, { headline: 'Three' }] })
    }
    const out = await suggestMaterialTexts({ brand, chat }, { formatId: 'merch-shirt', userId: 'ana' })
    expect(out.variants).toEqual([{ headline: 'One' }, { headline: 'Two' }, { headline: 'Three' }])
    expect(calls[0].map((m) => m.content).join('\n')).toContain('slogan')
  })

  it('without an active brand voice it still writes, and says so', async () => {
    const chat: MaterialChat = async () => reply({ variants: pieces })
    const out = await suggestMaterialTexts({ brand: new InMemoryBrandStore(), chat }, { formatId: 'flyer-a5', userId: 'ana' })
    expect(out).toMatchObject({ voice: false, locale: null })
  })

  it('with several active voices it needs a locale', async () => {
    const brand = new InMemoryBrandStore()
    await activeVoice(brand, 'de')
    await activeVoice(brand, 'en')
    const chat: MaterialChat = async () => reply({ variants: pieces })
    await expect(suggestMaterialTexts({ brand, chat }, { formatId: 'flyer-a5', userId: 'ana' })).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('de, en'),
    })
    await expect(suggestMaterialTexts({ brand, chat }, { formatId: 'flyer-a5', userId: 'ana', locale: 'en' })).resolves.toMatchObject({ locale: 'en' })
  })

  it('retries an unreadable or over-long answer, then fails loud — never guessed texts', async () => {
    const brand = new InMemoryBrandStore()
    let n = 0
    const chat: MaterialChat = async () => {
      n += 1
      if (n === 1) return reply('not json')
      if (n === 2) return reply({ variants: [piece(1)] })
      return reply({ variants: pieces })
    }
    await expect(suggestMaterialTexts({ brand, chat }, { formatId: 'flyer-a5', userId: 'ana' })).resolves.toMatchObject({ variants: pieces })
    expect(n).toBe(3)

    const long: MaterialChat = async () => reply({ variants: [piece(1), piece(2), { ...piece(3), headline: 'x'.repeat(MATERIAL_COPY_LIMITS.headline + 1) }] })
    await expect(suggestMaterialTexts({ brand, chat: long }, { formatId: 'flyer-a5', userId: 'ana' })).rejects.toMatchObject({ code: 'upstream' })

    const merchBody: MaterialChat = async () => reply({ variants: pieces })
    await expect(suggestMaterialTexts({ brand, chat: merchBody }, { formatId: 'merch-mug', userId: 'ana' })).rejects.toMatchObject({ code: 'upstream' })
  })

  it('no AI provider is a plain unavailable error; a provider refusal is upstream', async () => {
    const brand = new InMemoryBrandStore()
    const none: MaterialChat = async () => {
      throw new LlmNotConfiguredError('no provider')
    }
    await expect(suggestMaterialTexts({ brand, chat: none }, { formatId: 'flyer-a5', userId: 'ana' })).rejects.toMatchObject({
      code: 'unavailable',
      message: MATERIAL_NO_PROVIDER_MESSAGE,
    })
    const refused: MaterialChat = async () => {
      throw new LlmHttpError(429, 'slow down')
    }
    await expect(suggestMaterialTexts({ brand, chat: refused }, { formatId: 'flyer-a5', userId: 'ana' })).rejects.toMatchObject({ code: 'upstream' })
  })

  it('an unknown format is invalid', async () => {
    const chat: MaterialChat = async () => reply({ variants: pieces })
    await expect(suggestMaterialTexts({ brand: new InMemoryBrandStore(), chat }, { formatId: 'nope', userId: 'ana' })).rejects.toMatchObject({ code: 'invalid' })
  })
})
