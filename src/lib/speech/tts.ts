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
 *
 * The voice plays on the speaker chosen for this browser (Audio devices in the
 * settings menu; the same choice calls use, `$lib/calls/devices`). A speaker
 * that cannot be chosen (setSinkId rejects) means silence, console-warned —
 * never the voice on a different device. A browser without setSinkId plays on
 * its current output; the settings row says it cannot choose.
 *
 * Speed and volume (owner proposal 74cbc486) are this browser's choice too, like the switch and
 * the speaker: `ee-voice-speed` (0.75–2×, default 1.15× — a little faster than the voice as
 * the gateway delivers it) and `ee-voice-volume` (0–1). Both are PLAYBACK settings on the audio
 * element (playbackRate with preservesPitch, volume), so they cost no extra synthesis and a
 * change applies to the reply being read right now.
 */
import { readRemembered } from '$lib/calls/devices'

const STORAGE_KEY = 'ee-voice'

export function isVoiceEnabled(): boolean {
  if (typeof window === 'undefined' || !window.localStorage) return false
  return window.localStorage.getItem(STORAGE_KEY) !== 'off'
}

const voiceListeners = new Set<(enabled: boolean) => void>()

/**
 * Every place that shows the voice switch (the settings menu, the assistant's chat) hears each
 * change, so they never disagree. Returns the unsubscribe.
 */
export function onVoiceEnabledChange(listener: (enabled: boolean) => void): () => void {
  voiceListeners.add(listener)
  return () => voiceListeners.delete(listener)
}

/** Off means off now: what is being read (or still loading) stops at once. */
export function setVoiceEnabled(enabled: boolean): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  if (enabled) {
    window.localStorage.removeItem(STORAGE_KEY)
  } else {
    window.localStorage.setItem(STORAGE_KEY, 'off')
    cancelSpeak()
  }
  for (const listener of voiceListeners) listener(enabled)
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

export const VOICE_SPEED = { min: 0.75, max: 2, step: 0.05, default: 1.15 } as const
const SPEED_KEY = 'ee-voice-speed'
const VOLUME_KEY = 'ee-voice-volume'

export type VoicePlayback = { speed: number; volume: number }

function inSpeedRange(n: number): boolean {
  return Number.isFinite(n) && n >= VOICE_SPEED.min && n <= VOICE_SPEED.max
}
function inVolumeRange(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= 1
}

function readStored(key: string, valid: (n: number) => boolean, fallback: number): number {
  const raw = window.localStorage.getItem(key)
  if (raw === null) return fallback
  const n = Number(raw)
  if (raw.trim() === '' || !valid(n)) {
    console.error(
      `[tts] the remembered voice setting ${key} (${JSON.stringify(raw)}) is unreadable; using the default until it is chosen again`,
    )
    return fallback
  }
  return n
}

/** This browser's voice speed and volume (defaults when nothing was chosen). */
export function getVoicePlayback(): VoicePlayback {
  if (typeof window === 'undefined' || !window.localStorage)
    return { speed: VOICE_SPEED.default, volume: 1 }
  return {
    speed: readStored(SPEED_KEY, inSpeedRange, VOICE_SPEED.default),
    volume: readStored(VOLUME_KEY, inVolumeRange, 1),
  }
}

/**
 * Whether this browser lets a page set media volume. iOS Safari keeps it read-only (always 1;
 * the hardware buttons own it), so a volume slider there would do nothing.
 */
export function canSetMediaVolume(): boolean {
  if (typeof Audio === 'undefined') return false
  const probe = new Audio()
  probe.volume = 0.5
  return probe.volume === 0.5
}

const playbackListeners = new Set<(playback: VoicePlayback) => void>()

/** The chat's popover and the settings menu both hear each change. Returns the unsubscribe. */
export function onVoicePlaybackChange(listener: (playback: VoicePlayback) => void): () => void {
  playbackListeners.add(listener)
  return () => playbackListeners.delete(listener)
}

function applyPlayback(audio: HTMLAudioElement, playback: VoicePlayback): void {
  audio.preservesPitch = true
  audio.playbackRate = playback.speed
  audio.volume = playback.volume
}

function playbackChanged(): void {
  const playback = getVoicePlayback()
  if (currentAudio) applyPlayback(currentAudio, playback)
  for (const listener of playbackListeners) listener(playback)
}

/** Speed as a multiple of the delivered voice (0.75–2). Applies to the current reading at once. */
export function setVoiceSpeed(speed: number): void {
  if (!inSpeedRange(speed)) {
    throw new Error(
      `Voice speed must be between ${VOICE_SPEED.min}× and ${VOICE_SPEED.max}× (got ${speed}).`,
    )
  }
  window.localStorage.setItem(SPEED_KEY, String(speed))
  playbackChanged()
}

/** Volume from 0 (silent) to 1 (full). Applies to the current reading at once. */
export function setVoiceVolume(volume: number): void {
  if (!inVolumeRange(volume))
    throw new Error(`Voice volume must be between 0 and 1 (got ${volume}).`)
  window.localStorage.setItem(VOLUME_KEY, String(volume))
  playbackChanged()
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
    applyPlayback(audio, getVoicePlayback())
    const speaker = readRemembered(window.localStorage).audiooutput
    if (speaker && typeof audio.setSinkId === 'function') {
      try {
        await audio.setSinkId(speaker)
      } catch (err) {
        console.warn('[tts] the chosen speaker could not be used — staying silent.', err)
        if (currentAudio === audio) {
          URL.revokeObjectURL(audio.src)
          currentAudio = null
        }
        return
      }
      if (currentAudio !== audio) return // cancelled while choosing the speaker
    }
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
