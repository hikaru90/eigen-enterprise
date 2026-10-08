import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelSpeak, isVoiceEnabled, setVoiceEnabled, speak } from './tts'

type RecordedUtterance = { text: string }

function makeSynthesis() {
  const spoken: RecordedUtterance[] = []
  let cancelled = 0
  const synthesis = {
    speak: (utterance: SpeechSynthesisUtterance) => {
      spoken.push({ text: utterance.text })
    },
    cancel: () => {
      cancelled += 1
    },
    speaking: false,
    pending: false,
    paused: false,
    pause: () => {},
    resume: () => {},
    getVoices: () => [],
    onvoiceschanged: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }
  return { synthesis, spoken, cancelled: () => cancelled }
}

const g = globalThis as {
  window?: { localStorage?: unknown; speechSynthesis?: unknown }
  SpeechSynthesisUtterance?: unknown
}

describe('tts — the assistant speaks', () => {
  let synth: ReturnType<typeof makeSynthesis>
  let storage: Map<string, string>

  beforeEach(() => {
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        text: string
        rate = 1
        constructor(text: string) {
          this.text = text
        }
      },
    )
    storage = new Map()
    synth = makeSynthesis()
    g.window = {
      localStorage: {
        getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
        setItem: (k: string, v: string) => void storage.set(k, v),
        removeItem: (k: string) => void storage.delete(k),
      },
      speechSynthesis: synth.synthesis,
    }
  })

  afterEach(() => {
    delete g.window
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

  it('speaks plain text and cancels whatever was speaking first', () => {
    speak('Hello. Your company OS is getting set up.')

    expect(synth.spoken).toHaveLength(1)
    expect(synth.spoken[0]!.text).toBe('Hello. Your company OS is getting set up.')
    expect(synth.cancelled()).toBe(1)
  })

  it('reads content, not markdown syntax', () => {
    speak(
      [
        '## Your site',
        '',
        '- **First** point with [a link](https://example.com)',
        '- Second point',
        '',
        '```js',
        'const notProse = true',
        '```',
        '',
        'Done.',
      ].join('\n'),
    )

    const text = synth.spoken[0]!.text
    expect(text).toContain('Your site')
    expect(text).toContain('First point with a link')
    expect(text).toContain('Second point')
    expect(text).toContain('Done.')
    expect(text).not.toContain('```')
    expect(text).not.toContain('**')
    expect(text).not.toContain('https://')
    expect(text).not.toContain('const notProse')
  })

  it('says nothing when voice is off or the text is empty — never throws', () => {
    setVoiceEnabled(false)
    speak('hello')
    expect(synth.spoken).toHaveLength(0)

    setVoiceEnabled(true)
    speak('   \n  ')
    expect(synth.spoken).toHaveLength(0)

    cancelSpeak()
    expect(synth.cancelled()).toBe(1)
  })
})
