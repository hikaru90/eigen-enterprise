/**
 * Boot-sequence sound: synthesized with Web Audio — no assets, no dependencies.
 * ON by default (owner decision 2026-09-07); the browser tab mute is always
 * available, and a persisted flag (`ee-sound` in localStorage) is the in-app
 * toggle. AudioContext creation is deferred to the first user gesture: browsers
 * refuse audio without one, and we never fight that — a cold first load simply
 * stays silent until the user interacts.
 */

const STORAGE_KEY = 'ee-sound'

let ctx: AudioContext | null = null
let gestureHooked = false

export function isSoundEnabled(): boolean {
  if (typeof window === 'undefined' || !window.localStorage) return false
  return window.localStorage.getItem(STORAGE_KEY) !== 'off'
}

export function setSoundEnabled(enabled: boolean): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  if (enabled) {
    window.localStorage.removeItem(STORAGE_KEY)
  } else {
    window.localStorage.setItem(STORAGE_KEY, 'off')
  }
}

/**
 * Hooks the one-time gesture listeners that unlock the AudioContext. Safe to
 * call on every mount; does nothing on the server or after the first gesture.
 */
export function primeBootSound(): void {
  if (typeof window === 'undefined' || gestureHooked) return
  gestureHooked = true
  const unlock = () => {
    void ensureContext()
    window.removeEventListener('pointerdown', unlock)
    window.removeEventListener('keydown', unlock)
  }
  window.addEventListener('pointerdown', unlock, { passive: true })
  window.addEventListener('keydown', unlock, { passive: true })
}

function ensureContext(): AudioContext | null {
  if (!isSoundEnabled()) return null
  if (ctx) {
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    return ctx
  }
  try {
    ctx = new AudioContext()
    return ctx
  } catch {
    // No Web Audio in this environment: the sequence stays visual. Deterministic,
    // logged — not a silent product failure; sound is an enhancement.
    console.warn('[boot-sound] Web Audio unavailable — continuing without sound.')
    return null
  }
}

/** One soft sine voice with an attack/decay envelope. Returns a stop handle for tests. */
function voice(
  frequency: number,
  startDelayS: number,
  durationS: number,
  peakGain: number,
  type: OscillatorType = 'sine',
): void {
  const audio = ensureContext()
  if (!audio) return
  try {
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    const t0 = audio.currentTime + startDelayS
    osc.type = type
    osc.frequency.setValueAtTime(frequency, t0)
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.exponentialRampToValueAtTime(peakGain, t0 + durationS * 0.25)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durationS)
    osc.connect(gain).connect(audio.destination)
    osc.start(t0)
    osc.stop(t0 + durationS + 0.05)
  } catch (err) {
    console.warn('[boot-sound] voice failed', err)
  }
}

/** Boot: a soft rising swell — the light coming up. */
export function playBootSwell(): void {
  voice(174.6, 0, 1.6, 0.035) // F3
  voice(261.6, 0.12, 1.5, 0.028) // C4
  voice(349.2, 0.26, 1.4, 0.02) // F4
}

/** Act transition: a quiet pulse under the text change. */
export function playActPulse(): void {
  voice(523.3, 0, 0.28, 0.022) // C5
}

/** The mind connected: a two-note confirmation. */
export function playConnectChime(): void {
  voice(392, 0, 0.35, 0.03) // G4
  voice(587.3, 0.14, 0.5, 0.03) // D5
}
