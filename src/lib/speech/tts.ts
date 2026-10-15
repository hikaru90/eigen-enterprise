/**
 * Voice output for the company OS: the assistant speaks what it says (the Her
 * layer) through the LLM gateway's neural TTS — POST /api/tts (qwen tts via
 * OpenRouter, the same BYOK config that pays for chat and STT). The browser's
 * speechSynthesis robot voice is GONE and is never a fallback: a failing or
 * missing gateway means silence (console-warned), the same honest state as an
 * unsupported browser was before.
 *
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

let currentAudio: HTMLAudioElement | null = null
let currentFetch: AbortController | null = null

/** Stops current speech — new turns and new boot acts never overlap voices. */
export function cancelSpeak(): void {
  currentFetch?.abort()
  currentFetch = null
  if (currentAudio) {
    currentAudio.pause()
    if (currentAudio.src.startsWith('blob:')) URL.revokeObjectURL(currentAudio.src)
    currentAudio = null
  }
}

/** Speaks assistant text (markdown allowed). Cancels whatever was speaking. */
export function speak(markdown: string): void {
  const text = speakableText(markdown)
  if (!text) return
  if (!isVoiceEnabled()) return
  void speakGatewayText(text)
}

async function speakGatewayText(text: string): Promise<void> {
  cancelSpeak()
  const fetchController = new AbortController()
  currentFetch = fetchController
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: fetchController.signal,
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      console.warn('[tts] gateway speech failed — staying silent.', {
        status: res.status,
        error: body?.error,
      })
      return
    }
    if (currentFetch !== fetchController) return // cancelled while loading
    const blob = await res.blob()
    if (currentFetch !== fetchController) return
    const audio = new Audio(URL.createObjectURL(blob))
    currentAudio = audio
    audio.onended = () => {
      if (currentAudio === audio) {
        URL.revokeObjectURL(audio.src)
        currentAudio = null
      }
    }
    await audio.play()
  } catch (err) {
    if (fetchController.signal.aborted) return // superseded or cancelled: quiet
    console.warn('[tts] speak failed', err)
  } finally {
    if (currentFetch === fetchController) currentFetch = null
  }
}
