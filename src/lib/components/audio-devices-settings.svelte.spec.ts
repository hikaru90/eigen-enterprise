import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { DEVICES_KEY, type DeviceInfo } from '$lib/calls/devices'
import AudioDevicesSettings, { type AudioDevicesEnv } from './audio-devices-settings.svelte'

/**
 * Settings menu → Audio devices: the ONE microphone + speaker choice per browser, shared with
 * calls (`ee.calls.devices`). Everything browser-side is injected.
 */

const LABELLED: DeviceInfo[] = [
  { kind: 'audioinput', deviceId: 'default', label: 'Default - Built-in Microphone' },
  { kind: 'audioinput', deviceId: 'mic-2', label: 'USB Headset' },
  { kind: 'audiooutput', deviceId: 'default', label: 'Default - Built-in Speakers' },
  { kind: 'audiooutput', deviceId: 'spk-2', label: 'Desk Speakers' },
  { kind: 'videoinput', deviceId: 'cam-1', label: 'FaceTime HD Camera' },
]
/** What browsers list before microphone permission: entries without ids or names. */
const UNLABELLED: DeviceInfo[] = [
  { kind: 'audioinput', deviceId: '', label: '' },
  { kind: 'audiooutput', deviceId: '', label: '' },
]

function fakeEnv(opts: { devices?: DeviceInfo[]; stored?: Record<string, string>; canChooseSpeaker?: boolean } = {}) {
  const data: Record<string, string> = opts.stored ? { [DEVICES_KEY]: JSON.stringify(opts.stored) } : {}
  let devices = opts.devices ?? LABELLED
  const listeners = new Set<() => void>()
  const track = { stop: vi.fn() }
  const media = {
    enumerateDevices: vi.fn(async () => devices),
    getUserMedia: vi.fn(async () => ({ getTracks: () => [track] }) as unknown as MediaStream),
    addEventListener: vi.fn((_type: 'devicechange', fn: () => void) => void listeners.add(fn)),
    removeEventListener: vi.fn((_type: 'devicechange', fn: () => void) => void listeners.delete(fn)),
  }
  const env: AudioDevicesEnv = {
    media,
    storage: { getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) },
    canChooseSpeaker: opts.canChooseSpeaker ?? true,
  }
  return {
    env,
    media,
    track,
    listeners,
    stored: () => (data[DEVICES_KEY] ? (JSON.parse(data[DEVICES_KEY]) as Record<string, string>) : {}),
    plug(next: DeviceInfo[]) {
      devices = next
      for (const fn of listeners) fn()
    },
  }
}

const optionTexts = (testid: string) =>
  [...(page.getByTestId(testid).element() as HTMLSelectElement).options].map((o) => o.textContent?.trim())

describe('audio-devices-settings.svelte', () => {
  it('lists microphones and speakers by name, with System default selected when nothing is chosen', async () => {
    const f = fakeEnv()
    render(AudioDevicesSettings, { env: f.env })

    await expect.element(page.getByTestId('audio-device-audioinput')).toHaveValue('')
    expect(optionTexts('audio-device-audioinput')).toEqual(['System default', 'Default - Built-in Microphone', 'USB Headset'])
    expect(optionTexts('audio-device-audiooutput')).toEqual(['System default', 'Default - Built-in Speakers', 'Desk Speakers'])
    await expect.element(page.getByTestId('audio-devices-allow')).not.toBeInTheDocument()
  })

  it('choosing a microphone and a speaker remembers them in the shared call-device storage', async () => {
    const f = fakeEnv({ stored: { videoinput: 'cam-1' } })
    render(AudioDevicesSettings, { env: f.env })

    await page.getByTestId('audio-device-audioinput').selectOptions('USB Headset')
    await page.getByTestId('audio-device-audiooutput').selectOptions('Desk Speakers')
    expect(f.stored()).toEqual({ videoinput: 'cam-1', audioinput: 'mic-2', audiooutput: 'spk-2' })

    // System default forgets the choice; the camera choice (calls) stays.
    await page.getByTestId('audio-device-audioinput').selectOptions('System default')
    expect(f.stored()).toEqual({ videoinput: 'cam-1', audiooutput: 'spk-2' })
  })

  it('shows the remembered choice as selected', async () => {
    const f = fakeEnv({ stored: { audioinput: 'mic-2', audiooutput: 'spk-2' } })
    render(AudioDevicesSettings, { env: f.env })

    await expect.element(page.getByTestId('audio-device-audioinput')).toHaveValue('mic-2')
    await expect.element(page.getByTestId('audio-device-audiooutput')).toHaveValue('spk-2')
  })

  it('a chosen device that is unplugged says so instead of pretending another is chosen', async () => {
    const f = fakeEnv({ stored: { audioinput: 'gone-mic' } })
    render(AudioDevicesSettings, { env: f.env })

    await expect.element(page.getByTestId('audio-device-audioinput')).toHaveValue('gone-mic')
    await expect.element(page.getByTestId('audio-device-missing')).toHaveTextContent('Your chosen microphone is not connected')
  })

  it('before microphone permission: says why the names are missing and asks once, then lists the devices', async () => {
    const f = fakeEnv({ devices: UNLABELLED })
    render(AudioDevicesSettings, { env: f.env })

    await expect.element(page.getByTestId('audio-devices-allow')).toHaveTextContent('Allow microphone to see devices')
    expect(optionTexts('audio-device-audioinput')).toEqual(['System default'])

    f.media.getUserMedia.mockImplementationOnce(async () => {
      f.plug(LABELLED)
      return { getTracks: () => [f.track] } as unknown as MediaStream
    })
    await page.getByTestId('audio-devices-allow').click()

    await expect.element(page.getByTestId('audio-devices-allow')).not.toBeInTheDocument()
    expect(f.media.getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(f.track.stop).toHaveBeenCalledTimes(1)
    expect(optionTexts('audio-device-audioinput')).toContain('USB Headset')
  })

  it('a denied permission is shown plainly', async () => {
    const f = fakeEnv({ devices: UNLABELLED })
    f.media.getUserMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
    render(AudioDevicesSettings, { env: f.env })

    await page.getByTestId('audio-devices-allow').click()
    await expect.element(page.getByTestId('audio-devices-problem')).toHaveTextContent('Microphone permission denied')
  })

  it('refreshes on devicechange and stops listening when it goes away', async () => {
    const f = fakeEnv({ devices: LABELLED.filter((d) => d.deviceId !== 'mic-2') })
    const { unmount } = render(AudioDevicesSettings, { env: f.env })

    await expect.element(page.getByTestId('audio-device-audioinput')).toBeInTheDocument()
    expect(optionTexts('audio-device-audioinput')).not.toContain('USB Headset')
    f.plug(LABELLED)
    await vi.waitFor(() => expect(optionTexts('audio-device-audioinput')).toContain('USB Headset'))

    unmount()
    expect(f.listeners.size).toBe(0)
  })

  it('where the browser cannot choose the speaker, the speaker row says so', async () => {
    const f = fakeEnv({ canChooseSpeaker: false })
    render(AudioDevicesSettings, { env: f.env })

    await expect.element(page.getByTestId('audio-speaker-unsupported')).toHaveTextContent('This browser cannot choose the speaker')
    await expect.element(page.getByTestId('audio-device-audiooutput')).not.toBeInTheDocument()
    await expect.element(page.getByTestId('audio-device-audioinput')).toBeInTheDocument()
  })

  it('no media devices API at all: says so, no selects', async () => {
    const f = fakeEnv()
    render(AudioDevicesSettings, { env: { ...f.env, media: null } })

    await expect.element(page.getByTestId('audio-devices-unavailable')).toBeInTheDocument()
    await expect.element(page.getByTestId('audio-device-audioinput')).not.toBeInTheDocument()
  })
})
