import type { ActiveCall } from './active-call.svelte'
import { clipHasSpeechLevelSound, decodeClip } from '$lib/voice/clip-speech'
import { CallRequestError, type LiveCallClient } from './client'

/**
 * Call transcripts, my side (direction agreed 2026-11-19, option A): this
 * browser records MY OWN microphone — the track the call publishes, so the
 * device I chose and muting apply — in ~30 s chunks and sends each one to be
 * transcribed. No bot, no one else's audio; the server keeps the text, never
 * the audio.
 *
 * Records only while: I am connected, my microphone is on, and my
 * transcription is on (consent per person, on by default; my switch is stored
 * with the call, so a rejoin keeps it, and everyone in the call sees it).
 *
 *   - mute / reconnecting / hang up: stop, and send what was said so far
 *   - I turn my transcription off: stop at once and DROP the chunk in progress
 *   - a chunk without speech-level sound is never sent ($lib/voice/clip-speech)
 *   - the server has no speech to text: say so once, stop (the call goes on)
 *   - a chunk that failed: say so, keep recording
 *
 * Driven by ActiveCall.subscribe (every change of the call or its phase) and
 * the toggle — no effects. Browser bits (MediaRecorder, timers, decoding) are
 * injected; browserCallTranscription wires the real ones.
 */

/** One recording, started when made; stop() ends it and gives the clip. */
export type ChunkRecorder = { stop(): Promise<Blob> }

export type TranscribedCall = Pick<ActiveCall, 'call' | 'state' | 'subscribe' | 'microphoneTrack' | 'update'>

export type CallTranscriptionDeps = {
  active: TranscribedCall
  /** My participant id (user id, or a guest's identity). */
  me: string
  client: Pick<LiveCallClient, 'transcribe' | 'setTranscription'>
  /** Starts recording this track now. */
  record: (track: MediaStreamTrack) => ChunkRecorder
  /** Layer 1 of "silence never becomes text": false → the clip is not sent. */
  hasSpeech: (clip: Blob) => Promise<boolean>
  chunkMs: number
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (timer: unknown) => void
}

type Chunk = { recorder: ChunkRecorder; callId: string; startedAt: number }

export class CallTranscription {
  /** My switch while the server has not answered yet (null: the call's own view decides). */
  #pending = $state<boolean | null>(null)
  #recording = $state(false)
  #unavailable = $state(false)
  #problem = $state<string | null>(null)

  readonly #d: CallTranscriptionDeps
  #chunk: Chunk | null = null
  #timer: unknown = null
  #unsubscribe: (() => void) | null = null

  constructor(deps: CallTranscriptionDeps) {
    this.#d = deps
  }

  /** My microphone is transcribed (my switch). */
  get on(): boolean {
    if (this.#pending !== null) return this.#pending
    return this.#d.active.call?.participants.find((p) => p.userId === this.#d.me)?.transcribing === true
  }

  /** Recording right now. */
  get recording(): boolean {
    return this.#recording
  }

  /** The names of the people in the call whose microphone is transcribed (me included while I am). */
  get transcribed(): string[] {
    const call = this.#d.active.call
    if (!call) return []
    return call.participants
      .filter((p) => (p.userId === this.#d.me ? this.on && !this.#unavailable : p.transcribing && p.inRoom))
      .map((p) => p.name)
  }

  /** Someone in the call is transcribed: the indicator everyone sees. */
  get anyone(): boolean {
    return this.transcribed.length > 0
  }

  /** This server has no speech to text: nothing of mine is transcribed. */
  get unavailable(): boolean {
    return this.#unavailable
  }

  /** What went wrong, in words; null while fine. */
  get problem(): string | null {
    return this.#problem
  }

  dismissProblem(): void {
    if (!this.#unavailable) this.#problem = null
  }

  /** Start following the call (the call page, on mount). */
  connect(): void {
    if (this.#unsubscribe) return
    this.#unsubscribe = this.#d.active.subscribe(() => this.#reconcile())
    this.#reconcile()
  }

  /** Stop following (the call page going away). A chunk still recording is dropped. */
  close(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = null
    this.#stop(true)
  }

  /** My switch: on → off stops at once and drops the chunk in progress. Everyone in the call sees it. */
  async toggle(): Promise<void> {
    const call = this.#d.active.call
    if (!call) return
    const on = !this.on
    this.#pending = on
    this.#reconcile()
    try {
      this.#d.active.update(await this.#d.client.setTranscription(call.id, on))
    } catch (err) {
      this.#problem = `Your transcription could not be turned ${on ? 'on' : 'off'}: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      this.#pending = null
      this.#reconcile()
    }
  }

  #wanted(): boolean {
    const { active } = this.#d
    return this.#unsubscribe !== null && !this.#unavailable && active.call !== null && active.state.phase === 'connected' && active.state.mic && this.on
  }

  #reconcile(): void {
    const want = this.#wanted()
    if (want && !this.#chunk) this.#start()
    else if (!want && this.#chunk) this.#stop(!this.on || this.#unavailable)
  }

  #start(): void {
    const call = this.#d.active.call
    const track = this.#d.active.microphoneTrack()
    // No track yet (the microphone is still starting): the next change of the call tries again.
    if (!call || !track) return
    this.#chunk = { recorder: this.#d.record(track), callId: call.id, startedAt: this.#d.now() }
    this.#recording = true
    this.#timer = this.#d.setTimer(() => this.#rotate(), this.#d.chunkMs)
  }

  /** A chunk is full: send it, start the next one (with the microphone track as it is now). */
  #rotate(): void {
    this.#timer = null
    const done = this.#take()
    if (done) void this.#send(done.chunk, done.clip, done.durationMs)
    this.#reconcile()
  }

  #stop(drop: boolean): void {
    if (this.#timer !== null) this.#d.clearTimer(this.#timer)
    this.#timer = null
    const done = this.#take()
    if (!done) return
    if (drop) done.clip.catch((err: unknown) => console.error('[calls] stopping a dropped transcript chunk failed', err))
    else void this.#send(done.chunk, done.clip, done.durationMs)
  }

  #take(): { chunk: Chunk; clip: Promise<Blob>; durationMs: number } | null {
    const chunk = this.#chunk
    if (!chunk) return null
    this.#chunk = null
    this.#recording = false
    return { chunk, clip: chunk.recorder.stop(), durationMs: this.#d.now() - chunk.startedAt }
  }

  async #send(chunk: Chunk, clipping: Promise<Blob>, durationMs: number): Promise<void> {
    let clip: Blob
    try {
      clip = await clipping
    } catch (err) {
      this.#problem = `A part of your transcript was not recorded: ${err instanceof Error ? err.message : String(err)}`
      return
    }
    if (clip.size === 0 || durationMs <= 0 || !(await this.#d.hasSpeech(clip))) return
    try {
      await this.#d.client.transcribe(chunk.callId, clip, durationMs)
    } catch (err) {
      const problem = err instanceof CallRequestError ? err.problem : { kind: 'failed' as const, message: err instanceof Error ? err.message : String(err) }
      if (problem.kind === 'unavailable') {
        this.#unavailable = true
        this.#problem = problem.message
        this.#reconcile()
      } else if (problem.kind === 'over') {
        // The call ended (or my transcription went off) while this chunk was on its way: nothing to keep.
        console.warn('[calls] a transcript chunk arrived after it could be used:', problem.message)
      } else {
        this.#problem = `A part of your transcript was not saved: ${problem.message}`
      }
    }
  }
}

/** The recorder's preferred formats: what speech to text accepts (as dictation records). */
const PREFERRED_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/mp4'] as const
const AUDIO_BITS_PER_SECOND = 32_000

/** One MediaRecorder per chunk on the call's microphone track (each chunk a whole, decodable file). */
export function mediaRecorderChunk(track: MediaStreamTrack): ChunkRecorder {
  const mimeType = PREFERRED_MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t))
  const recorder = new MediaRecorder(new MediaStream([track]), { audioBitsPerSecond: AUDIO_BITS_PER_SECOND, ...(mimeType ? { mimeType } : {}) })
  const parts: Blob[] = []
  recorder.addEventListener('dataavailable', (e) => {
    if (e.data.size > 0) parts.push(e.data)
  })
  recorder.start()
  return {
    stop: () =>
      new Promise<Blob>((resolve, reject) => {
        const done = () => resolve(new Blob(parts, { type: recorder.mimeType || parts[0]?.type || 'audio/webm' }))
        if (recorder.state === 'inactive') return done()
        recorder.addEventListener('stop', done, { once: true })
        recorder.addEventListener('error', (e) => reject(new Error(`the recorder failed (${(e as ErrorEvent).message ?? 'unknown'})`)), { once: true })
        recorder.stop()
      }),
  }
}

/**
 * Layer 1 on a chunk. A chunk the browser cannot decode cannot be judged, so
 * it counts as sound and is sent (logged) — as dictation does.
 */
export async function chunkHasSpeech(clip: Blob): Promise<boolean> {
  try {
    return clipHasSpeechLevelSound(await decodeClip(clip))
  } catch (err) {
    console.warn('[calls] a transcript chunk could not be decoded for the audio check; sending it unchecked', err)
    return true
  }
}

/** The live wiring for the call page and the guest page. */
export function browserCallTranscription(active: TranscribedCall, me: string, client: Pick<LiveCallClient, 'transcribe' | 'setTranscription'>, chunkMs: number) {
  return new CallTranscription({
    active,
    me,
    client,
    record: mediaRecorderChunk,
    hasSpeech: chunkHasSpeech,
    chunkMs,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  })
}
