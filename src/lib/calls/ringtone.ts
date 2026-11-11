/**
 * The incoming-call ringtone: a short two-note chime every 2.5 s, generated
 * with Web Audio (no asset). Browsers may keep audio suspended until the
 * person has interacted with the page (autoplay rules); then the chime is
 * simply silent — the toast still shows. Never throws.
 */

export type Ringer = { start(): void; stop(): void }

const NOTES = [
  { freq: 659.25, at: 0 },
  { freq: 880, at: 0.18 },
]
const PERIOD_MS = 2_500

export function webAudioRinger(): Ringer {
  let ctx: AudioContext | null = null
  let timer: ReturnType<typeof setInterval> | undefined

  const chime = () => {
    if (!ctx || ctx.state !== 'running') return
    const t0 = ctx.currentTime
    for (const n of NOTES) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = n.freq
      gain.gain.setValueAtTime(0, t0 + n.at)
      gain.gain.linearRampToValueAtTime(0.12, t0 + n.at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + 0.35)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t0 + n.at)
      osc.stop(t0 + n.at + 0.4)
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
      ctx
        .resume()
        .then(chime)
        .catch(() => {})
      timer = setInterval(chime, PERIOD_MS)
    },
    stop() {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
  }
}
