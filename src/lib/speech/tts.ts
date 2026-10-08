/**
 * Voice output for the company OS: the assistant speaks what it says (the Her
 * layer). Browser SpeechSynthesis — no assets, no dependencies, no LLM cost.
 * ON by default (consistent with the boot sound, owner decision 2026-09-07);
 * `ee-voice` in localStorage is the in-app toggle (settings menu). Speaking is
 * formatting normalization of assistant text only — never semantic logic.
 */

const STORAGE_KEY = 'ee-voice'

export function isVoiceEnabled(): boolean {
  if (typeof window === 'undefined' || !window.localStorage) return false
  return window.localStorage.getItem(STORAGE_KEY) !== 'off'
}

export function setVoiceEnabled(enabled: boolean): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  if (enabled) {
    window.localStorage.removeItem(STORAGE_KEY)
  } else {
    window.localStorage.setItem(STORAGE_KEY, 'off')
  }
}

function synthesis(): SpeechSynthesis | null {
  if (typeof window === 'undefined' || !window.localStorage) return null
  if (!isVoiceEnabled()) return null
  try {
    if (!window.speechSynthesis) {
      console.warn('[tts] SpeechSynthesis unavailable — staying silent.')
      return null
    }
    return window.speechSynthesis
  } catch {
    return null
  }
}

/**
 * Strips markdown formatting so the voice reads content, not syntax: code
 * fences and inline code out (their content is not prose), links collapse to
 * their label, emphasis markers and heading hashes go, bullets become pauses.
 */
export function speakableText(markdown: string): string {
  const withoutCode = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*\*|\*\*|__|_\b|~~)/g, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\|/g, ' ')
  return withoutCode.replace(/\s+/g, ' ').trim()
}

/** Stops current speech — new turns and new boot acts never overlap voices. */
export function cancelSpeak(): void {
  try {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel()
    }
  } catch {
    // Nothing speaking / unsupported: silence is the correct state.
  }
}

/** Speaks assistant text (markdown allowed). Cancels whatever was speaking. */
export function speak(markdown: string): void {
  const text = speakableText(markdown)
  if (!text) return
  const synth = synthesis()
  if (!synth) return
  try {
    synth.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = 1.03
    synth.speak(utterance)
  } catch (err) {
    console.warn('[tts] speak failed', err)
  }
}
