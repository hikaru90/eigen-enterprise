import { describe, expect, it } from 'vitest'
import { LlmNotConfiguredError } from '$lib/server/llm/errors'
import type { ChatMessage } from '$lib/server/llm/llm-client'
import { InMemoryBrandStore } from '../store'
import { CAPTION_LOG_CONTEXT, NETWORK_CAPTION_LIMITS, NO_PROVIDER_MESSAGE, suggestCaptions, type CaptionChat } from './captions'
import { InMemorySocialPostStore } from './store'

const person = { kind: 'user' as const, userId: 'ana' }

function reply(payload: unknown) {
  return { choices: [{ message: { content: typeof payload === 'string' ? payload : JSON.stringify(payload) } }] }
}

function three(prefix: string) {
  return [`${prefix} one`, `${prefix} two`, `${prefix} three`]
}

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

async function setup() {
  const posts = new InMemorySocialPostStore()
  const brand = new InMemoryBrandStore()
  const post = await posts.createGraphic(
    {
      title: 'Launch teaser',
      format: 'square',
      graphic: { headline: 'Bald ist es da', body: 'Nächste Woche.', cta: 'Dabei sein', mode: 'light' },
      networks: ['instagram', 'x'],
    },
    person,
  )
  return { posts, brand, post }
}

describe('suggestCaptions', () => {
  it('asks the gateway once for three captions per network, in the active brand voice', async () => {
    const { posts, brand, post } = await setup()
    await activeVoice(brand)
    const calls: Array<{ messages: ChatMessage[]; logContext?: string; responseFormat?: string; userId: string }> = []
    const chat: CaptionChat = async (input) => {
      calls.push(input)
      return reply({ captions: { instagram: three('IG'), x: three('X') } })
    }
    const out = await suggestCaptions({ posts, brand, chat }, { postId: post.id, userId: 'ana' })
    expect(out).toEqual({ postId: post.id, locale: 'de', voice: true, captions: { instagram: three('IG'), x: three('X') } })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ userId: 'ana', logContext: CAPTION_LOG_CONTEXT, responseFormat: 'json_object' })
    const prompt = calls[0].messages.map((m) => m.content).join('\n')
    for (const text of ['Bald ist es da', 'Wir zeigen, wie es geht.', 'REVOLUTIONÄR!!!', 'disruptiv', 'Nucleus', 'candid without hype', '"x"', '280']) {
      expect(prompt).toContain(text)
    }
  })

  it('limits the networks to the ones asked for (they must be targeted by the post)', async () => {
    const { posts, brand, post } = await setup()
    const chat: CaptionChat = async () => reply({ captions: { x: three('X') } })
    const out = await suggestCaptions({ posts, brand, chat }, { postId: post.id, userId: 'ana', networks: ['x'] })
    expect(Object.keys(out.captions)).toEqual(['x'])
    await expect(
      suggestCaptions({ posts, brand, chat }, { postId: post.id, userId: 'ana', networks: ['linkedin'] }),
    ).rejects.toThrow(/does not target: linkedin/)
  })

  it('without an active brand voice it still suggests, and says so', async () => {
    const { posts, brand, post } = await setup()
    const chat: CaptionChat = async () => reply({ captions: { instagram: three('IG'), x: three('X') } })
    const out = await suggestCaptions({ posts, brand, chat }, { postId: post.id, userId: 'ana' })
    expect(out).toMatchObject({ voice: false, locale: null })
  })

  it('with several active voices it needs a locale, and uses the one asked for', async () => {
    const { posts, brand, post } = await setup()
    await activeVoice(brand, 'de')
    await activeVoice(brand, 'en')
    const chat: CaptionChat = async () => reply({ captions: { instagram: three('IG'), x: three('X') } })
    await expect(suggestCaptions({ posts, brand, chat }, { postId: post.id, userId: 'ana' })).rejects.toThrow(/de, en/)
    await expect(suggestCaptions({ posts, brand, chat }, { postId: post.id, userId: 'ana', locale: 'en' })).resolves.toMatchObject({
      locale: 'en',
      voice: true,
    })
  })

  it('retries an unreadable answer, then fails loud — never guessed captions', async () => {
    const { posts, brand, post } = await setup()
    let n = 0
    const chat: CaptionChat = async () => {
      n += 1
      if (n === 1) return reply('not json')
      if (n === 2) return reply({ captions: { instagram: ['only one'], x: three('X') } })
      return reply({ captions: { instagram: three('IG'), x: three('X') } })
    }
    await expect(suggestCaptions({ posts, brand, chat }, { postId: post.id, userId: 'ana' })).resolves.toMatchObject({ voice: false })
    expect(n).toBe(3)

    const bad: CaptionChat = async () => reply({ captions: { instagram: three('IG'), x: ['x'.repeat(NETWORK_CAPTION_LIMITS.x + 1), 'b', 'c'] } })
    await expect(suggestCaptions({ posts, brand, chat: bad }, { postId: post.id, userId: 'ana' })).rejects.toMatchObject({ code: 'upstream' })
  })

  it('no AI provider is a plain unavailable error', async () => {
    const { posts, brand, post } = await setup()
    const chat: CaptionChat = async () => {
      throw new LlmNotConfiguredError('no provider')
    }
    await expect(suggestCaptions({ posts, brand, chat }, { postId: post.id, userId: 'ana' })).rejects.toMatchObject({
      code: 'unavailable',
      message: NO_PROVIDER_MESSAGE,
    })
  })

  it('an unknown post is not_found', async () => {
    const { posts, brand } = await setup()
    const chat: CaptionChat = async () => reply({})
    await expect(
      suggestCaptions({ posts, brand, chat }, { postId: '00000000-0000-4000-8000-000000000000', userId: 'ana' }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})
