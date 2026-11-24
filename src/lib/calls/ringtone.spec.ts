import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RING_PERIOD_MS, webAudioRinger } from './ringtone'

type GainCall = {
  setValueAtTime: ReturnType<typeof vi.fn>
  linearRampToValueAtTime: ReturnType<typeof vi.fn>
  exponentialRampToValueAtTime: ReturnType<typeof vi.fn>
}

type FakeGainNode = {
  gain: GainCall
  connectedTo: unknown[]
  connect: ReturnType<typeof vi.fn>
}

type FakeOscillatorNode = {
  type: OscillatorType
  frequency: { value: number }
  onended: (() => void) | null
  connectedTo: unknown[]
  connect: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}

type FakeCompressorNode = {
  threshold: { value: number }
  knee: { value: number }
  ratio: { value: number }
  attack: { value: number }
  release: { value: number }
  connectedTo: unknown[]
  connect: ReturnType<typeof vi.fn>
}

function createFakeAudioContext(options: {
  withCompressor?: boolean
  state?: AudioContextState
  resumeImpl?: () => Promise<void>
} = {}) {
  const { withCompressor = true, state = 'running', resumeImpl } = options
  const destination = { kind: 'destination' }
  const oscillators: FakeOscillatorNode[] = []
  const gains: FakeGainNode[] = []
  const compressors: FakeCompressorNode[] = []

  const ctx = {
    state,
    currentTime: 0,
    destination,
    resume: vi.fn(resumeImpl ?? (async () => {})),
    createOscillator: vi.fn(() => {
      const osc: FakeOscillatorNode = {
        type: 'sine',
        frequency: { value: 440 },
        onended: null,
        connectedTo: [],
        connect: vi.fn((dest: unknown) => {
          osc.connectedTo.push(dest)
          return dest
        }),
        start: vi.fn(),
        stop: vi.fn(),
        disconnect: vi.fn(),
      }
      oscillators.push(osc)
      return osc
    }),
    createGain: vi.fn(() => {
      const node: FakeGainNode = {
        gain: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connectedTo: [],
        connect: vi.fn((dest: unknown) => {
          node.connectedTo.push(dest)
          return dest
        }),
      }
      gains.push(node)
      return node
    }),
    ...(withCompressor
      ? {
          createDynamicsCompressor: vi.fn(() => {
            const comp: FakeCompressorNode = {
              threshold: { value: 0 },
              knee: { value: 0 },
              ratio: { value: 0 },
              attack: { value: 0 },
              release: { value: 0 },
              connectedTo: [],
              connect: vi.fn((dest: unknown) => {
                comp.connectedTo.push(dest)
                return dest
              }),
            }
            compressors.push(comp)
            return comp
          }),
        }
      : {}),
  }

  return { ctx, destination, oscillators, gains, compressors }
}

describe('webAudioRinger', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('plays a double-burst 3-note dual-oscillator motif routed through a DynamicsCompressorNode', async () => {
    const fake = createFakeAudioContext()
    const AudioCtx = vi.fn(function FakeAudioContext() {
      return fake.ctx
    })
    vi.stubGlobal('AudioContext', AudioCtx)

    const ringer = webAudioRinger()
    ringer.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(AudioCtx).toHaveBeenCalledTimes(1)
    expect(fake.compressors).toHaveLength(1)
    expect(fake.compressors[0].connectedTo).toContain(fake.destination)

    // 2 bursts * 3 notes * 2 oscillators (triangle fundamental + sine upper harmonic) = 12 oscillators
    expect(fake.oscillators).toHaveLength(12)
    expect(fake.gains).toHaveLength(12)

    for (const g of fake.gains) {
      expect(g.connectedTo).toContain(fake.compressors[0])
    }

    const fundamentals = fake.oscillators.filter((o) => o.type === 'triangle')
    const harmonics = fake.oscillators.filter((o) => o.type === 'sine')
    expect(fundamentals).toHaveLength(6)
    expect(harmonics).toHaveLength(6)

    expect(fundamentals.map((o) => o.frequency.value)).toEqual([
      880,
      1108.73,
      1318.51,
      880,
      1108.73,
      1318.51,
    ])
    expect(harmonics.map((o) => o.frequency.value)).toEqual([
      880 * 2,
      1108.73 * 2,
      1318.51 * 2,
      880 * 2,
      1108.73 * 2,
      1318.51 * 2,
    ])

    for (const o of fake.oscillators) {
      expect(o.start).toHaveBeenCalledTimes(1)
      expect(o.stop).toHaveBeenCalledTimes(1)
    }

    ringer.stop()
  })

  it('connects gains directly to destination when createDynamicsCompressor is absent', async () => {
    const fake = createFakeAudioContext({ withCompressor: false })
    vi.stubGlobal(
      'AudioContext',
      vi.fn(function FakeAudioContext() {
        return fake.ctx
      }),
    )

    const ringer = webAudioRinger()
    ringer.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(fake.compressors).toHaveLength(0)
    expect(fake.oscillators).toHaveLength(12)
    for (const g of fake.gains) {
      expect(g.connectedTo).toContain(fake.destination)
    }

    ringer.stop()
  })

  it('uses penetrant gain levels (~0.34 fundamental + ~0.14 harmonic) with exponential decay', async () => {
    const fake = createFakeAudioContext()
    vi.stubGlobal(
      'AudioContext',
      vi.fn(function FakeAudioContext() {
        return fake.ctx
      }),
    )

    const ringer = webAudioRinger()
    ringer.start()
    await vi.advanceTimersByTimeAsync(0)

    const fundamentalPeaks: number[] = []
    const harmonicPeaks: number[] = []

    fake.oscillators.forEach((osc, idx) => {
      const gain = fake.gains[idx]
      expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0, expect.any(Number))
      expect(gain.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.0001, expect.any(Number))
      const peak = gain.gain.linearRampToValueAtTime.mock.calls[0]?.[0] as number
      if (osc.type === 'triangle') fundamentalPeaks.push(peak)
      else harmonicPeaks.push(peak)
    })

    expect(fundamentalPeaks).toHaveLength(6)
    expect(harmonicPeaks).toHaveLength(6)
    for (const p of fundamentalPeaks) expect(p).toBeCloseTo(0.34, 2)
    for (const p of harmonicPeaks) expect(p).toBeCloseTo(0.14, 2)

    ringer.stop()
  })

  it('repeats the motif every 1,800 ms', async () => {
    expect(RING_PERIOD_MS).toBe(1_800)
    const fake = createFakeAudioContext()
    vi.stubGlobal(
      'AudioContext',
      vi.fn(function FakeAudioContext() {
        return fake.ctx
      }),
    )

    const ringer = webAudioRinger()
    ringer.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.oscillators).toHaveLength(12)

    await vi.advanceTimersByTimeAsync(1_799)
    expect(fake.oscillators).toHaveLength(12)

    await vi.advanceTimersByTimeAsync(1)
    expect(fake.oscillators).toHaveLength(24)

    await vi.advanceTimersByTimeAsync(1_800)
    expect(fake.oscillators).toHaveLength(36)

    ringer.stop()
  })

  it('keeps start()/stop() idempotent, cancels interval and active voices, and skips ringing if stopped before resume resolves', async () => {
    const fake = createFakeAudioContext()
    vi.stubGlobal(
      'AudioContext',
      vi.fn(function FakeAudioContext() {
        return fake.ctx
      }),
    )

    const ringer = webAudioRinger()
    expect(() => ringer.stop()).not.toThrow()

    ringer.start()
    ringer.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(fake.ctx.resume).toHaveBeenCalledTimes(1)
    expect(fake.compressors).toHaveLength(1)
    expect(fake.oscillators).toHaveLength(12)

    ringer.stop()
    for (const osc of fake.oscillators) {
      expect(osc.stop).toHaveBeenCalledTimes(2)
      expect(osc.disconnect).toHaveBeenCalledTimes(1)
    }

    await vi.advanceTimersByTimeAsync(10_000)
    expect(fake.oscillators).toHaveLength(12)

    expect(() => ringer.stop()).not.toThrow()

    // Can restart cleanly after stop()
    ringer.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.oscillators).toHaveLength(24)
    ringer.stop()

    // Stopping before resume() settles prevents scheduling any oscillators
    let resolveResume!: () => void
    const deferredFake = createFakeAudioContext({
      resumeImpl: () =>
        new Promise<void>((resolve) => {
          resolveResume = resolve
        }),
    })
    vi.stubGlobal(
      'AudioContext',
      vi.fn(function FakeAudioContext() {
        return deferredFake.ctx
      }),
    )
    const deferredRinger = webAudioRinger()
    deferredRinger.start()
    deferredRinger.stop()
    resolveResume()
    await vi.advanceTimersByTimeAsync(0)
    expect(deferredFake.oscillators).toHaveLength(0)
  })

  it('never throws when AudioContext is missing, throws, stays suspended, or fails resume()', async () => {
    vi.stubGlobal('AudioContext', undefined)
    const missing = webAudioRinger()
    expect(() => missing.start()).not.toThrow()
    expect(() => missing.stop()).not.toThrow()

    vi.stubGlobal(
      'AudioContext',
      vi.fn(function ThrowingAudioContext() {
        throw new Error('blocked')
      }),
    )
    const throwing = webAudioRinger()
    expect(() => throwing.start()).not.toThrow()
    expect(() => throwing.stop()).not.toThrow()

    const suspended = createFakeAudioContext({ state: 'suspended' })
    vi.stubGlobal(
      'AudioContext',
      vi.fn(function SuspendedAudioContext() {
        return suspended.ctx
      }),
    )
    const suspendedRinger = webAudioRinger()
    suspendedRinger.start()
    await vi.advanceTimersByTimeAsync(1_800)
    expect(suspended.oscillators).toHaveLength(0)
    suspendedRinger.stop()

    const rejected = createFakeAudioContext({
      resumeImpl: async () => {
        throw new Error('autoplay prevented')
      },
    })
    vi.stubGlobal(
      'AudioContext',
      vi.fn(function RejectedAudioContext() {
        return rejected.ctx
      }),
    )
    const rejectedRinger = webAudioRinger()
    rejectedRinger.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(rejected.oscillators).toHaveLength(0)
    rejectedRinger.stop()
  })
})
