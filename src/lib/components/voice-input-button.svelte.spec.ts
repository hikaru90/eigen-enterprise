import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { transcribeAudioChunk, transcribeRecordedAudio } from '$lib/capture/transcribe-audio'
import VoiceInputButtonTestHarness from './voice-input-button-test-harness.svelte'

vi.mock('$lib/capture/transcribe-audio', () => ({
  transcribeRecordedAudio: vi.fn(async () => ''),
  transcribeAudioChunk: vi.fn(async () => ''),
}))

/** Minimal MediaRecorder stub that records lifecycle calls without real audio. */
class FakeMediaRecorder {
  static last: FakeMediaRecorder | null = null
  static isTypeSupported(mime: string) {
    return mime === 'audio/webm' || mime === 'audio/webm;codecs=opus'
  }
  mimeType = 'audio/webm;codecs=opus'
  state: 'inactive' | 'recording' = 'inactive'
  ondataavailable: ((ev: { data: { size: number } }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  startSpy = vi.fn()
  stopSpy = vi.fn()
  stream: MediaStream
  opts: MediaRecorderOptions | undefined
  constructor(stream: MediaStream, opts?: MediaRecorderOptions) {
    this.stream = stream
    this.opts = opts
    FakeMediaRecorder.last = this
  }
  /** The recorder hands over a timeslice of audio. */
  emit(bytes = 8) {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)], { type: this.mimeType }) } as never)
  }
  start() {
    this.startSpy()
    this.state = 'recording'
  }
  stop() {
    this.stopSpy()
    this.state = 'inactive'
    this.onstop?.()
  }
}

function fakeTrack() {
  return { stop: vi.fn(), kind: 'audio' }
}

function fakeStream(): MediaStream {
  const tracks = [fakeTrack(), fakeTrack()]
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks,
    getVideoTracks: () => [],
    active: true,
    id: 'stream-1',
  } as unknown as MediaStream
}

/** AudioContext stub so startLevelMeter runs without touching real audio. */
class FakeAudioContext {
  readonly state = 'running'
  createMediaStreamSource() {
    return { connect: vi.fn() } as unknown as AudioNode
  }
  createAnalyser() {
    const samples = new Uint8Array(256)
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      getByteTimeDomainData: (arr: Uint8Array) => {
        arr.set(samples)
      },
      connect: vi.fn(),
    } as unknown as AnalyserNode
  }
  resume() {}
  close() {}
}

const originalMediaRecorder = (globalThis as { MediaRecorder?: unknown }).MediaRecorder
const originalAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')

function installStubs(): MediaStream {
  Object.defineProperty(globalThis, 'MediaRecorder', {
    configurable: true,
    writable: true,
    value: FakeMediaRecorder,
  })
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    writable: true,
    value: FakeAudioContext,
  })
  const stream = fakeStream()
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => stream),
      enumerateDevices: vi.fn(async () => []),
    },
  })
  return stream
}

function restoreStubs() {
  if (originalMediaRecorder !== undefined) {
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      writable: true,
      value: originalMediaRecorder,
    })
  }
  if (originalAudioContext !== undefined) {
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      writable: true,
      value: originalAudioContext,
    })
  }
  if (originalMediaDevices) {
    Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices)
  }
}

describe('voice-input-button.svelte', () => {
  let stream: MediaStream

  beforeEach(() => {
    stream = installStubs()
    FakeMediaRecorder.last = null
    vi.mocked(transcribeAudioChunk).mockClear()
    vi.mocked(transcribeRecordedAudio).mockClear()
  })

  afterEach(() => {
    restoreStubs()
  })

  it('exposes stopRef as a function once recording is active', async () => {
    const onstart = vi.fn()
    const { component } = render(VoiceInputButtonTestHarness, {
      onstart,
      ontranscript: vi.fn(),
      onpartialtranscript: vi.fn(),
    })

    expect(component.stopRef).toBeUndefined()
    await page.getByRole('button', { name: 'Start voice input' }).click()
    await expect
      .element(page.getByRole('button', { name: 'Stop recording and transcribe' }))
      .toBeInTheDocument()
    expect(onstart).toHaveBeenCalledTimes(1)
    expect(typeof component.stopRef).toBe('function')
  })

  it('stopRecording stops the recorder, aborts the scheduler, and releases the stream', async () => {
    const onstop = vi.fn()
    const { component } = render(VoiceInputButtonTestHarness, {
      onstop,
      ontranscript: vi.fn(),
      onpartialtranscript: vi.fn(),
    })

    await page.getByRole('button', { name: 'Start voice input' }).click()
    await expect
      .element(page.getByRole('button', { name: 'Stop recording and transcribe' }))
      .toBeInTheDocument()
    expect(typeof component.stopRef).toBe('function')

    const tracks = stream.getTracks()
    component.stopRef!()
    // Stream tracks are released.
    for (const track of tracks) {
      expect(track.stop).toHaveBeenCalledTimes(1)
    }
    expect(onstop).toHaveBeenCalledTimes(1)
    // After stop, the button returns to the idle mic state and stopRef is cleared.
    await expect
      .element(page.getByRole('button', { name: 'Start voice input' }))
      .toBeInTheDocument()
    expect(component.stopRef).toBeUndefined()
  })

  it('stopRecording is idempotent — calling twice does not double-stop or throw', async () => {
    const onstop = vi.fn()
    const { component } = render(VoiceInputButtonTestHarness, {
      onstop,
      ontranscript: vi.fn(),
      onpartialtranscript: vi.fn(),
    })

    await page.getByRole('button', { name: 'Start voice input' }).click()
    await expect
      .element(page.getByRole('button', { name: 'Stop recording and transcribe' }))
      .toBeInTheDocument()
    const tracks = stream.getTracks()

    // the same function a parent held on to (the bound prop itself is cleared on stop)
    const stop = component.stopRef!
    stop()
    expect(onstop).toHaveBeenCalledTimes(1)
    expect(component.stopRef).toBeUndefined()
    // Second call is a no-op (guard returns early).
    expect(() => stop()).not.toThrow()
    expect(onstop).toHaveBeenCalledTimes(1)
    for (const track of tracks) {
      expect(track.stop).toHaveBeenCalledTimes(1)
    }
  })

  it('does not expose stopRef before recording starts', async () => {
    const { component } = render(VoiceInputButtonTestHarness, {
      ontranscript: vi.fn(),
    })
    expect(component.stopRef).toBeUndefined()
  })

  it('while recording the stop control stays a button, with the mic level as a meter inside it', async () => {
    render(VoiceInputButtonTestHarness, { ontranscript: vi.fn() })
    await page.getByRole('button', { name: 'Start voice input' }).click()
    const stop = page.getByRole('button', { name: 'Stop recording and transcribe' })
    await expect.element(stop).toHaveAttribute('aria-pressed', 'true')
    await expect.element(page.getByRole('meter', { name: 'Microphone level' })).toBeInTheDocument()
  })

  it('records speech-sized opus (32 kbps), not the browser default', async () => {
    render(VoiceInputButtonTestHarness, { ontranscript: vi.fn() })
    await page.getByRole('button', { name: 'Start voice input' }).click()
    await vi.waitFor(() => expect(FakeMediaRecorder.last).not.toBeNull())
    expect(FakeMediaRecorder.last!.opts).toEqual({ audioBitsPerSecond: 32_000, mimeType: 'audio/webm;codecs=opus' })
  })

  it('without a live-text caller nothing is sent before Stop; Stop sends the clip once, with no forced language', async () => {
    const ontranscript = vi.fn()
    vi.mocked(transcribeRecordedAudio).mockResolvedValueOnce('hallo zusammen')
    render(VoiceInputButtonTestHarness, { ontranscript })
    await page.getByRole('button', { name: 'Start voice input' }).click()
    await vi.waitFor(() => expect(FakeMediaRecorder.last).not.toBeNull())
    FakeMediaRecorder.last!.emit()
    FakeMediaRecorder.last!.emit()
    expect(transcribeAudioChunk).not.toHaveBeenCalled()

    await page.getByRole('button', { name: 'Stop recording and transcribe' }).click()
    await vi.waitFor(() => expect(ontranscript).toHaveBeenCalledWith('hallo zusammen'))
    expect(transcribeRecordedAudio).toHaveBeenCalledTimes(1)
    expect(vi.mocked(transcribeRecordedAudio).mock.calls[0]![1]).toEqual({ language: undefined })
  })

  it('a caller that shows live text gets previews while recording', async () => {
    const onpartialtranscript = vi.fn()
    vi.mocked(transcribeAudioChunk).mockResolvedValueOnce('hallo')
    render(VoiceInputButtonTestHarness, { ontranscript: vi.fn(), onpartialtranscript })
    await page.getByRole('button', { name: 'Start voice input' }).click()
    await vi.waitFor(() => expect(FakeMediaRecorder.last).not.toBeNull())
    FakeMediaRecorder.last!.emit()
    await vi.waitFor(() => expect(onpartialtranscript).toHaveBeenCalledWith('hallo'))
  })

  describe('the microphone chosen for this browser (shared with calls)', () => {
    afterEach(() => {
      window.localStorage.removeItem('ee.calls.devices')
    })

    it('records from exactly the chosen microphone', async () => {
      window.localStorage.setItem('ee.calls.devices', JSON.stringify({ audioinput: 'mic-2' }))
      render(VoiceInputButtonTestHarness, { ontranscript: vi.fn() })
      await page.getByRole('button', { name: 'Start voice input' }).click()
      await vi.waitFor(() =>
        expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: 'mic-2' } } }),
      )
    })

    it('the chosen microphone is gone: the error names it, and nothing records from another mic', async () => {
      window.localStorage.setItem('ee.calls.devices', JSON.stringify({ audioinput: 'mic-2' }))
      const getUserMedia = vi.mocked(navigator.mediaDevices.getUserMedia)
      getUserMedia.mockRejectedValueOnce(new DOMException('gone', 'OverconstrainedError'))
      vi.mocked(navigator.mediaDevices.enumerateDevices).mockResolvedValueOnce([
        { kind: 'audioinput', deviceId: 'mic-2', label: 'USB Headset', groupId: 'g' } as MediaDeviceInfo,
      ])
      const onerror = vi.fn()
      render(VoiceInputButtonTestHarness, { ontranscript: vi.fn(), onerror })
      await page.getByRole('button', { name: 'Start voice input' }).click()
      await vi.waitFor(() =>
        expect(onerror).toHaveBeenCalledWith(
          'The chosen microphone (USB Headset) is not available. Choose another under Audio devices in the settings menu.',
        ),
      )
      expect(getUserMedia).toHaveBeenCalledTimes(1)
      await expect.element(page.getByRole('button', { name: 'Start voice input' })).toBeInTheDocument()
    })
  })
})
