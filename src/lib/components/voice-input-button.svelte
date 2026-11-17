<script lang="ts">
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import Mic from '@lucide/svelte/icons/mic'
  import { onDestroy } from 'svelte'
  import { browser } from '$app/environment'
  import {
    createStreamingSttScheduler,
    type StreamingSttScheduler,
  } from '$lib/capture/streaming-stt-scheduler'
  import { transcribeRecordedAudio, transcribeAudioChunk } from '$lib/capture/transcribe-audio'
  import { Button } from '$lib/components/ui/button'
  import { browserMicrophoneDeps, openMicrophone } from '$lib/voice/microphone'
  import { VOICE_AUDIO_BITS_PER_SECOND } from '$lib/voice/voice-message'

  /**
   * Record-then-transcribe voice input (the assistant composer, Memory capture). Stop uploads
   * the whole clip once (`/api/capture/transcribe`, the accurate model with the company's
   * vocabulary). Only a caller that shows live text (`onpartialtranscript`) gets previews while
   * recording; without one nothing is sent before Stop — previews nobody sees only cost money
   * and queue ahead of the real transcription.
   *
   * `language` forces the spoken language; leave it out unless the person chose one — the
   * model hears which language is spoken (a never-chosen default forced German speech into
   * English, Contribute be1ad246).
   */
  let {
    disabled = false,
    language,
    ontranscript,
    onpartialtranscript,
    onerror,
    onstop,
    onstart,
    // $bindable() sets up parent binding; ESLint cannot see the read before reassignment in handlers.
    // eslint-disable-next-line no-useless-assignment -- Svelte bindable prop
    stopRef = $bindable(),
    class: className = '',
  }: {
    disabled?: boolean
    language?: string
    ontranscript: (text: string) => void
    onpartialtranscript?: (text: string) => void
    onerror?: (message: string) => void
    onstop?: () => void
    onstart?: () => void
    stopRef?: (() => void) | undefined
    class?: string
  } = $props()

  let recording = $state(false)
  let transcribing = $state(false)
  let mediaRecorder = $state<MediaRecorder | null>(null)
  let stream = $state<MediaStream | null>(null)
  /** Mic level 0–1 while recording. */
  let level = $state(0)
  let chunks: Blob[] = []
  let recorderMimeType = 'audio/webm'
  let sttScheduler: StreamingSttScheduler | null = null

  let audioContext: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let levelFrameId: number | null = null
  let levelSmooth = 0

  const busy = $derived(recording || transcribing)
  const micSupported = $derived(
    browser &&
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== 'undefined',
  )

  /** 10% floor so the level bar is always slightly visible while recording. */
  const pulseSize = $derived(Math.round(10 + level * 90))

  function stopLevelMeter() {
    if (levelFrameId !== null) {
      cancelAnimationFrame(levelFrameId)
      levelFrameId = null
    }
    level = 0
    levelSmooth = 0
    analyser = null
    if (audioContext) {
      void audioContext.close()
      audioContext = null
    }
  }

  function startLevelMeter(mediaStream: MediaStream) {
    stopLevelMeter()
    if (typeof AudioContext === 'undefined') return

    audioContext = new AudioContext()
    const source = audioContext.createMediaStreamSource(mediaStream)
    analyser = audioContext.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.8
    source.connect(analyser)

    const samples = new Uint8Array(analyser.fftSize)

    const tick = () => {
      if (!analyser) return
      analyser.getByteTimeDomainData(samples)
      let sumSq = 0
      for (const sample of samples) {
        const normalized = (sample - 128) / 128
        sumSq += normalized * normalized
      }
      const rms = Math.sqrt(sumSq / samples.length)
      const instant = Math.min(1, rms * 4)
      const smooth = instant > levelSmooth ? 0.2 : 0.08
      levelSmooth += (instant - levelSmooth) * smooth
      level = levelSmooth
      levelFrameId = requestAnimationFrame(tick)
    }

    void audioContext.resume()
    levelFrameId = requestAnimationFrame(tick)
  }

  function releaseStream() {
    stopLevelMeter()
    if (stream) {
      for (const track of stream.getTracks()) track.stop()
    }
    stream = null
  }

  async function startRecording() {
    if (!micSupported || busy || disabled) return
    chunks = []
    sttScheduler?.reset()
    const showPartial = onpartialtranscript
    sttScheduler = showPartial
      ? createStreamingSttScheduler({
          onTranscribe: (blob, signal) => transcribeAudioChunk(blob, { language, signal }),
          onPartial: (text) => showPartial(text),
        })
      : null
    try {
      const mediaStream = await openMicrophone(browserMicrophoneDeps())
      stream = mediaStream
      startLevelMeter(mediaStream)
      const preferredMime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : MediaRecorder.isTypeSupported('audio/wav')
            ? 'audio/wav'
            : ''
      recorderMimeType = preferredMime || 'audio/webm'
      // speech needs no more than 32 kbps opus: a quarter of the browser's default, so the
      // upload after Stop is a quarter as long
      const recorder = new MediaRecorder(mediaStream, {
        audioBitsPerSecond: VOICE_AUDIO_BITS_PER_SECOND,
        ...(preferredMime ? { mimeType: preferredMime } : {}),
      })
      // Prefer the recorder's reported MIME (mock fixtures may be WAV).
      if (recorder.mimeType?.trim()) {
        recorderMimeType = recorder.mimeType
      }
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) {
          chunks.push(ev.data)
          sttScheduler?.appendChunk(ev.data, recorderMimeType)
        }
      }
      recorder.onerror = () => {
        onerror?.('Recording failed')
        recording = false
        mediaRecorder = null
        stopRef = undefined
        releaseStream()
      }
      // 2-second timeslice: ondataavailable fires every ~2s with a webm/opus chunk.
      recorder.start(2000)
      mediaRecorder = recorder
      recording = true
      // Expose the stop function synchronously so the parent can stop an active
      // recording without waiting for a reactive tick (no $effect for control flow).
      stopRef = stopRecording
      onstart?.()
    } catch (err) {
      releaseStream()
      const message =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Microphone permission denied'
          : err instanceof Error
            ? err.message
            : 'Could not access microphone'
      onerror?.(message)
    }
  }

  async function stopAndTranscribe() {
    if (!mediaRecorder || !recording) return
    const recorder = mediaRecorder
    recording = false
    mediaRecorder = null
    stopRef = undefined
    stopLevelMeter()

    sttScheduler?.abort()
    sttScheduler = null
    onstop?.()

    const blob = await new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => {
        releaseStream()
        if (chunks.length === 0) {
          reject(new Error('No audio recorded'))
          return
        }
        const type = recorder.mimeType || chunks[0]?.type || 'audio/webm'
        resolve(new Blob(chunks, { type }))
      }
      recorder.stop()
    }).catch((err) => {
      releaseStream()
      throw err
    })

    transcribing = true
    try {
      const transcript = await transcribeRecordedAudio(blob, { language })
      ontranscript(transcript)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Transcription failed'
      onerror?.(message)
    } finally {
      transcribing = false
    }
  }

  async function stopRecording() {
    if (!mediaRecorder || !recording) return
    const recorder = mediaRecorder
    recording = false
    mediaRecorder = null
    stopRef = undefined
    stopLevelMeter()

    sttScheduler?.abort()
    sttScheduler = null

    // Stop recording without transcribing
    recorder.ondataavailable = null
    recorder.onerror = null
    recorder.onstop = null
    try {
      recorder.stop()
    } catch {
      // ignore
    }
    releaseStream()
    onstop?.()
  }

  async function toggleMic() {
    if (!micSupported) {
      onerror?.('Speech input is not supported in this browser')
      return
    }
    if (transcribing || disabled) return
    if (recording) {
      await stopAndTranscribe()
    } else {
      await startRecording()
    }
  }

  // stopRef is assigned synchronously in startRecording and cleared in
  // stopRecording / stopAndTranscribe / onDestroy — no $effect for control flow.

  onDestroy(() => {
    if (mediaRecorder && recording) {
      try {
        mediaRecorder.stop()
      } catch {
        // ignore
      }
    }
    sttScheduler?.abort()
    sttScheduler = null
    releaseStream()
    recording = false
    mediaRecorder = null
    stopRef = undefined
  })
</script>

<Button
  type="button"
  variant="outline"
  size="icon"
  class="relative overflow-hidden rounded-none border-black dark:border-border {className}"
  disabled={disabled || !micSupported || transcribing}
  onclick={toggleMic}
  aria-label={recording
    ? 'Stop recording and transcribe'
    : transcribing
      ? 'Transcribing'
      : 'Start voice input'}
  aria-pressed={recording}
>
  {#if recording}
    <!-- the mic level: a meter inside the stop button (the button stays a button) -->
    <div
      class="pointer-events-none absolute bottom-0 left-0 right-0 z-0 bg-primary/30 transition-[height] duration-100 ease-out"
      style="height: {pulseSize}%"
      role="meter"
      aria-label="Microphone level"
      aria-valuenow={pulseSize}
      aria-valuemin={0}
      aria-valuemax={100}
    ></div>
  {/if}
  <span class="relative z-10 inline-flex items-center justify-center">
    {#if transcribing}
      <LoaderCircle class="size-4 shrink-0 animate-spin" strokeWidth={1.75} />
    {:else if recording}
      <span
        class="voice-recording-stop inline-block size-3 shrink-0 rounded-[2px]"
        aria-hidden="true"
      ></span>
    {:else}
      <Mic class="size-4 shrink-0" strokeWidth={1.75} />
    {/if}
  </span>
</Button>

<style>
  @keyframes recording-stop-flash {
    0%,
    100% {
      background-color: var(--foreground);
    }
    50% {
      background-color: var(--destructive);
    }
  }

  .voice-recording-stop {
    animation: recording-stop-flash 2.2s ease-in-out infinite;
  }
</style>
