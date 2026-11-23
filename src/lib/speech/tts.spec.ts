import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  VOICE_SPEED,
  canSetMediaVolume,
  cancelSpeak,
  getVoicePlayback,
  isVoiceEnabled,
  onVoiceEnabledChange,
  onVoicePlaybackChange,
  setVoiceEnabled,
  setVoiceSpeed,
  setVoiceVolume,
  speak,
} from './tts'

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
    playbackRate: 1,
    preservesPitch: false,
    volume: 1,
    sinkId: '',
    setSinkId: vi.fn(async (id: string) => {
      element.sinkId = id
    }) as ((id: string) => Promise<void>) | undefined,
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

  describe('switching the voice off (b34ce781: reading aloud is toggleable)', () => {
    it('stops what is being read right now', async () => {
      speak('a long answer')
      await vi.waitFor(() => expect(audioElement.played).toBe(1))
      setVoiceEnabled(false)
      expect(audioElement.pause).toHaveBeenCalledTimes(1)
    })

    it('switched off while the voice is still loading: it never plays', async () => {
      let answer: (res: Response) => void = () => {}
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))),
      )
      speak('slow gateway')
      setVoiceEnabled(false)
      answer(new Response(new Blob([new Uint8Array([1])]), { status: 200 }))
      await new Promise((r) => setTimeout(r, 10))
      expect(audioElement.played).toBe(0)
    })

    it('tells every toggle (settings menu, chat) about the change, until it unsubscribes', () => {
      const seen: boolean[] = []
      const unsubscribe = onVoiceEnabledChange((on) => seen.push(on))
      setVoiceEnabled(false)
      setVoiceEnabled(true)
      unsubscribe()
      setVoiceEnabled(false)
      expect(seen).toEqual([false, true])
    })
  })

  describe('the speaker chosen for this browser (shared with calls)', () => {
    const chooseSpeaker = (id: string) =>
      storage.set('ee.calls.devices', JSON.stringify({ audiooutput: id }))

    it('plays through the remembered speaker, chosen before playback starts', async () => {
      chooseSpeaker('spk-2')
      audioElement.play.mockImplementation(async () => {
        expect(audioElement.sinkId).toBe('spk-2')
        audioElement.played += 1
      })
      speak('hello')
      await vi.waitFor(() => expect(audioElement.played).toBe(1))
      expect(audioElement.setSinkId).toHaveBeenCalledWith('spk-2')
    })

    it('nothing remembered: the browser default output, no sink chosen', async () => {
      speak('hello')
      await vi.waitFor(() => expect(audioElement.played).toBe(1))
      expect(audioElement.setSinkId).not.toHaveBeenCalled()
    })

    it('the speaker cannot be chosen (setSinkId fails): warned, and silent — never another device', async () => {
      chooseSpeaker('gone')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      audioElement.setSinkId = vi.fn(async () => {
        throw Object.assign(new Error('not found'), { name: 'NotFoundError' })
      })
      speak('hello')
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('[tts]'), expect.anything()),
      )
      await new Promise((r) => setTimeout(r, 0))
      expect(audioElement.played).toBe(0)
      warn.mockRestore()
    })

    it('a browser without setSinkId plays on the current output (the settings row says it cannot choose)', async () => {
      chooseSpeaker('spk-2')
      audioElement.setSinkId = undefined
      speak('hello')
      await vi.waitFor(() => expect(audioElement.played).toBe(1))
    })
  })
  describe('speed and volume (owner proposal 74cbc486: faster, and her volume editable)', () => {
    it('defaults to a little faster than the voice as delivered, at full volume', () => {
      expect(VOICE_SPEED).toEqual({ min: 0.75, max: 2, step: 0.05, default: 1.15 })
      expect(getVoicePlayback()).toEqual({ speed: 1.15, volume: 1 })
    })

    it('plays at the chosen speed and volume, pitch preserved (playback rate, no extra synthesis)', async () => {
      setVoiceSpeed(1.5)
      setVoiceVolume(0.4)
      audioElement.play.mockImplementation(async () => {
        expect(audioElement.playbackRate).toBe(1.5)
        expect(audioElement.preservesPitch).toBe(true)
        expect(audioElement.volume).toBe(0.4)
        audioElement.played += 1
      })
      speak('hello')
      await vi.waitFor(() => expect(audioElement.played).toBe(1))
      const body = JSON.parse(String(fetchCalls[0]!.init!.body)) as Record<string, unknown>
      expect(body).toEqual({ text: 'hello' })
    })

    it('the default speed applies when nothing was chosen', async () => {
      speak('hello')
      await vi.waitFor(() => expect(audioElement.played).toBe(1))
      expect(audioElement.playbackRate).toBe(1.15)
      expect(audioElement.volume).toBe(1)
    })

    it('a change applies to the reply being read right now', async () => {
      speak('a long answer')
      await vi.waitFor(() => expect(audioElement.played).toBe(1))
      setVoiceSpeed(2)
      setVoiceVolume(0)
      expect(audioElement.playbackRate).toBe(2)
      expect(audioElement.volume).toBe(0)
    })

    it('is remembered for this browser and read back', () => {
      setVoiceSpeed(0.75)
      setVoiceVolume(0.55)
      expect(storage.get('ee-voice-speed')).toBe('0.75')
      expect(storage.get('ee-voice-volume')).toBe('0.55')
      expect(getVoicePlayback()).toEqual({ speed: 0.75, volume: 0.55 })
    })

    it('refuses a speed or volume outside the range — loudly, nothing stored', () => {
      expect(() => setVoiceSpeed(0.5)).toThrow(/speed/)
      expect(() => setVoiceSpeed(2.5)).toThrow(/speed/)
      expect(() => setVoiceSpeed(Number.NaN)).toThrow(/speed/)
      expect(() => setVoiceVolume(-0.1)).toThrow(/volume/)
      expect(() => setVoiceVolume(1.1)).toThrow(/volume/)
      expect(storage.has('ee-voice-speed')).toBe(false)
      expect(storage.has('ee-voice-volume')).toBe(false)
    })

    it('an unreadable remembered value is reported and the default is used until chosen again', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      storage.set('ee-voice-speed', 'fast')
      storage.set('ee-voice-volume', '7')
      expect(getVoicePlayback()).toEqual({ speed: 1.15, volume: 1 })
      expect(error).toHaveBeenCalledTimes(2)
      error.mockRestore()
    })

    it('knows whether the browser lets a page set the volume (iOS Safari keeps it at 1)', () => {
      expect(canSetMediaVolume()).toBe(true)
      vi.stubGlobal(
        'Audio',
        class {
          get volume() {
            return 1
          }
          set volume(_v: number) {}
        },
      )
      expect(canSetMediaVolume()).toBe(false)
    })

    it('tells every control (chat popover, settings menu) about a change, until it unsubscribes', () => {
      const seen: { speed: number; volume: number }[] = []
      const unsubscribe = onVoicePlaybackChange((p) => seen.push(p))
      setVoiceSpeed(1.25)
      setVoiceVolume(0.5)
      unsubscribe()
      setVoiceSpeed(1)
      expect(seen).toEqual([
        { speed: 1.25, volume: 1 },
        { speed: 1.25, volume: 0.5 },
      ])
    })
  })
})
