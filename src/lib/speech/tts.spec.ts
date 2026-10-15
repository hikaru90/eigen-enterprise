import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelSpeak, isVoiceEnabled, setVoiceEnabled, speak } from './tts'

/**
 * The assistant speaks through the LLM gateway (/api/tts → qwen tts) — the
 * browser's speechSynthesis robot voice is gone. Fetch + Audio are stubbed;
 * a failing or missing gateway means SILENCE, never a speechSynthesis
 * fallback (that fallback was the bug).
 */

type FetchCall = { url: string; init?: RequestInit }

function makeAudioElement() {
  const element = {
    src: '',
    played: 0,
    onended: null as (() => void) | null,
    play: vi.fn(async () => {
      element.played += 1
    }),
    pause: vi.fn(),
  }
  return element
}

describe('tts — the assistant speaks (gateway voice)', () => {
  let storage: Map<string, string>
  let audioElement: ReturnType<typeof makeAudioElement>
  let fetchCalls: FetchCall[]
  let fetchRespond: () => Response

  beforeEach(() => {
    storage = new Map()
    audioElement = makeAudioElement()
    fetchCalls = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        fetchCalls.push({ url: String(url), init })
        return fetchRespond()
      }),
    )
    vi.stubGlobal(
      'Audio',
      class {
        constructor(src: string) {
          audioElement.src = src
          return audioElement
        }
      },
    )
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
        setItem: (k: string, v: string) => void storage.set(k, v),
        removeItem: (k: string) => void storage.delete(k),
      },
    })
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:mock-audio',
      revokeObjectURL: () => {},
    })
    fetchRespond = () =>
      new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('voice is on by default — consistent with the boot sound', () => {
    expect(isVoiceEnabled()).toBe(true)
  })

  it('persists the off decision and back on again', () => {
    setVoiceEnabled(false)
    expect(storage.get('ee-voice')).toBe('off')
    expect(isVoiceEnabled()).toBe(false)

    setVoiceEnabled(true)
    expect(storage.has('ee-voice')).toBe(false)
    expect(isVoiceEnabled()).toBe(true)
  })

  it('posts the speakable text to the gateway and plays the audio', async () => {
    speak(
      [
        '## Your site',
        '',
        '- **First** point with [a link](https://example.com)',
        '',
        '```js',
        'const notProse = true',
        '```',
      ].join('\n'),
    )

    await vi.waitFor(() => expect(audioElement.played).toBe(1))
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]!.url).toBe('/api/tts')
    const body = JSON.parse(String(fetchCalls[0]!.init!.body)) as { text: string }
    expect(body.text).toContain('Your site')
    expect(body.text).toContain('First point with a link')
    expect(body.text).not.toContain('```')
    expect(body.text).not.toContain('**')
    expect(body.text).not.toContain('https://')
    expect(body.text).not.toContain('const notProse')
    expect(audioElement.src).toContain('blob:')
  })

  it('says nothing when voice is off or the text is empty — never calls the gateway', async () => {
    setVoiceEnabled(false)
    speak('hello')
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchCalls).toHaveLength(0)

    setVoiceEnabled(true)
    speak('   \n  ')
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchCalls).toHaveLength(0)
  })

  it('a failing gateway means silence — never a robot-voice fallback, never a throw', async () => {
    fetchRespond = () =>
      new Response(JSON.stringify({ error: 'LLM TTS HTTP 401: bad key' }), { status: 401 })
    expect(() => speak('hello')).not.toThrow()
    await vi.waitFor(() => expect(fetchCalls).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 0))
    expect(audioElement.played).toBe(0)
  })

  it('cancelSpeak stops playback and aborts the in-flight request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      ),
    )
    speak('slow gateway')
    cancelSpeak()
    // The pending request was aborted via its signal; nothing played.
    expect(audioElement.played).toBe(0)
  })
})
