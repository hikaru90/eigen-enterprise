/**
 * The incoming-call ringtone: an assertive, unmistakable two-burst melodic
 * ringtone every 1.8 s, generated with Web Audio (no asset) and routed through
 * a DynamicsCompressorNode when available so loudness stays crisp without
 * clipping. Browsers may keep audio suspended until the person has interacted
 * with the page (autoplay rules); then the ring is simply silent — the toast
 * still shows. Never throws.
 */

export type Ringer = { start(): void; stop(): void }

export const RING_PERIOD_MS = 1_800

const NOTES = [
  // First crisp burst (A5 → C#6 → E6)
  { freq: 880, at: 0, dur: 0.11 },
  { freq: 1108.73, at: 0.09, dur: 0.11 },
  { freq: 1318.51, at: 0.18, dur: 0.2 },
  // Second crisp burst
  { freq: 880, at: 0.48, dur: 0.11 },
  { freq: 1108.73, at: 0.57, dur: 0.11 },
  { freq: 1318.51, at: 0.66, dur: 0.24 },
] as const

const FUNDAMENTAL_GAIN = 0.34
const HARMONIC_GAIN = 0.14
const ATTACK_S = 0.012

export function webAudioRinger(): Ringer {
  let ctx: AudioContext | null = null
  let output: AudioNode | null = null
  let timer: ReturnType<typeof setInterval> | undefined
  const active = new Set<OscillatorNode>()

  const ensureOutput = (c: AudioContext): AudioNode => {
    if (output) return output
    if (typeof c.createDynamicsCompressor === 'function') {
      const comp = c.createDynamicsCompressor()
      if (comp.threshold) comp.threshold.value = -14
      if (comp.knee) comp.knee.value = 12
      if (comp.ratio) comp.ratio.value = 6
      if (comp.attack) comp.attack.value = 0.003
      if (comp.release) comp.release.value = 0.12
      comp.connect(c.destination)
      output = comp
      return comp
    }
    output = c.destination
    return output
  }

  const playVoice = (
    c: AudioContext,
    dest: AudioNode,
    freq: number,
    type: OscillatorType,
    peakGain: number,
    start: number,
    dur: number,
  ) => {
    const osc = c.createOscillator()
    const gain = c.createGain()
    osc.type = type
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(peakGain, start + ATTACK_S)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur)
    osc.connect(gain).connect(dest)
    active.add(osc)
    osc.onended = () => {
      active.delete(osc)
    }
    osc.start(start)
    osc.stop(start + dur + 0.02)
  }

  const ring = () => {
    if (timer === undefined || !ctx || ctx.state !== 'running') return
    const dest = ensureOutput(ctx)
    const t0 = ctx.currentTime
    for (const n of NOTES) {
      playVoice(ctx, dest, n.freq, 'triangle', FUNDAMENTAL_GAIN, t0 + n.at, n.dur)
      playVoice(ctx, dest, n.freq * 2, 'sine', HARMONIC_GAIN, t0 + n.at, n.dur * 0.85)
    }
  }

  return {
    start() {
      if (timer !== undefined) return
      if (typeof AudioContext === 'undefined') return
      try {
        ctx ??= new AudioContext()
      } catch {
        return // no audio device / blocked: the toast alone rings
      }
      timer = setInterval(ring, RING_PERIOD_MS)
      try {
        void Promise.resolve(ctx.resume())
          .then(ring)
          .catch(() => {})
      } catch {
        // resume() threw synchronously: ignore silently
      }
    },
    stop() {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      for (const osc of active) {
        try {
          osc.stop()
        } catch {
          // already stopped
        }
        try {
          osc.disconnect?.()
        } catch {
          // already disconnected
        }
      }
      active.clear()
    },
  }
}
