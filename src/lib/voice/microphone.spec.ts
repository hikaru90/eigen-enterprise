import { describe, expect, it, vi } from 'vitest'
import { DEVICES_KEY, type DeviceInfo } from '$lib/calls/devices'
import { ChosenMicrophoneUnavailable, chosenMicrophoneMessage, openMicrophone, type MicrophoneDeps } from './microphone'

/**
 * Voice paths (dictation, voice messages, the voice input button) open the microphone the
 * person chose once for this browser — the same choice calls use (`ee.calls.devices`).
 */

const stream = { getTracks: () => [] } as unknown as MediaStream

function storage(remembered: Record<string, string> | null) {
  return {
    getItem: (k: string) => (k === DEVICES_KEY && remembered ? JSON.stringify(remembered) : null),
    setItem: vi.fn(),
  }
}

function deps(over: Partial<MicrophoneDeps> = {}): MicrophoneDeps & { getUserMedia: ReturnType<typeof vi.fn> } {
  return {
    getUserMedia: vi.fn(async () => stream),
    enumerateDevices: vi.fn(async (): Promise<DeviceInfo[]> => []),
    storage: storage(null),
    ...over,
  } as MicrophoneDeps & { getUserMedia: ReturnType<typeof vi.fn> }
}

const domError = (name: string) => Object.assign(new Error(name), { name })

describe('openMicrophone', () => {
  it('nothing chosen: the browser default microphone', async () => {
    const d = deps()
    await expect(openMicrophone(d)).resolves.toBe(stream)
    expect(d.getUserMedia).toHaveBeenCalledWith({ audio: true })
  })

  it('no storage in this browser: nothing chosen, the browser default', async () => {
    const d = deps({ storage: null })
    await openMicrophone(d)
    expect(d.getUserMedia).toHaveBeenCalledWith({ audio: true })
  })

  it('a chosen microphone: exactly that device', async () => {
    const d = deps({ storage: storage({ audioinput: 'mic-2' }) })
    await openMicrophone(d)
    expect(d.getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: 'mic-2' } } })
    expect(d.getUserMedia).toHaveBeenCalledTimes(1)
  })

  it.each(['OverconstrainedError', 'NotFoundError'])(
    'the chosen microphone is gone (%s): an explicit error naming it — never another microphone',
    async (name) => {
      const d = deps({
        storage: storage({ audioinput: 'mic-2' }),
        getUserMedia: vi.fn(async () => {
          throw domError(name)
        }),
        enumerateDevices: vi.fn(async () => [{ kind: 'audioinput' as const, deviceId: 'mic-2', label: 'USB Headset' }]),
      })
      const err = await openMicrophone(d).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ChosenMicrophoneUnavailable)
      expect((err as ChosenMicrophoneUnavailable).label).toBe('USB Headset')
      expect((err as Error).message).toBe(chosenMicrophoneMessage('USB Headset'))
      expect((err as Error).message).toContain('USB Headset')
      expect(d.getUserMedia).toHaveBeenCalledTimes(1)
    },
  )

  it('the chosen microphone is no longer listed: the error says it is not connected', async () => {
    const d = deps({
      storage: storage({ audioinput: 'mic-2' }),
      getUserMedia: vi.fn(async () => {
        throw domError('OverconstrainedError')
      }),
    })
    const err = (await openMicrophone(d).catch((e: unknown) => e)) as ChosenMicrophoneUnavailable
    expect(err).toBeInstanceOf(ChosenMicrophoneUnavailable)
    expect(err.label).toBeNull()
    expect(err.message).toBe(chosenMicrophoneMessage(null))
  })

  it('a denied permission stays what it is (not a chosen-device problem)', async () => {
    const denied = domError('NotAllowedError')
    const d = deps({
      storage: storage({ audioinput: 'mic-2' }),
      getUserMedia: vi.fn(async () => {
        throw denied
      }),
    })
    await expect(openMicrophone(d)).rejects.toBe(denied)
  })

  it('nothing chosen and no microphone: the browser error as it is', async () => {
    const gone = domError('NotFoundError')
    const d = deps({
      getUserMedia: vi.fn(async () => {
        throw gone
      }),
    })
    await expect(openMicrophone(d)).rejects.toBe(gone)
  })
})

describe('chosenMicrophoneMessage', () => {
  it('names the device and where to choose another', () => {
    expect(chosenMicrophoneMessage('USB Headset')).toBe(
      'The chosen microphone (USB Headset) is not available. Choose another under Audio devices in the settings menu.',
    )
    expect(chosenMicrophoneMessage(null)).toBe(
      'The chosen microphone is not connected. Choose another under Audio devices in the settings menu.',
    )
  })
})
