import { describe, expect, it, vi } from 'vitest'
import { DEVICES_KEY, deviceOptions, readRemembered, remember, selectedDevice, type DeviceInfo } from './devices'

const info = (kind: DeviceInfo['kind'], deviceId: string, label = ''): DeviceInfo => ({ kind, deviceId, label })

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => void (data[k] = v),
  }
}

describe('deviceOptions', () => {
  it('groups microphones, speakers and cameras, named by their label', () => {
    const d = deviceOptions([
      info('audioinput', 'default', 'Default - Built-in Microphone'),
      info('audioinput', 'mic-2', 'USB Headset'),
      info('audiooutput', 'default', 'Default - Built-in Speakers'),
      info('videoinput', 'cam-1', 'FaceTime HD Camera'),
    ])
    expect(d.audioinput).toEqual([
      { id: 'default', label: 'Default - Built-in Microphone' },
      { id: 'mic-2', label: 'USB Headset' },
    ])
    expect(d.audiooutput).toEqual([{ id: 'default', label: 'Default - Built-in Speakers' }])
    expect(d.videoinput).toEqual([{ id: 'cam-1', label: 'FaceTime HD Camera' }])
  })

  it('a device without a label gets a numbered name; entries without an id (no permission yet) are left out; duplicates once', () => {
    const d = deviceOptions([
      info('audioinput', ''),
      info('videoinput', 'cam-1'),
      info('videoinput', 'cam-2'),
      info('videoinput', 'cam-2'),
    ])
    expect(d.audioinput).toEqual([])
    expect(d.videoinput).toEqual([
      { id: 'cam-1', label: 'Camera 1' },
      { id: 'cam-2', label: 'Camera 2' },
    ])
  })
})

describe('remembered devices (per browser)', () => {
  it('remembers a choice per kind and reads it back', () => {
    const s = memoryStorage()
    remember(s, 'audioinput', 'mic-2')
    remember(s, 'videoinput', 'cam-1')
    expect(readRemembered(s)).toEqual({ audioinput: 'mic-2', videoinput: 'cam-1' })
    expect(JSON.parse(s.data[DEVICES_KEY])).toEqual({ audioinput: 'mic-2', videoinput: 'cam-1' })
  })

  it('nothing stored reads as nothing remembered', () => {
    expect(readRemembered(memoryStorage())).toEqual({})
  })

  it('a broken stored value is reported (console.error) and read as nothing remembered', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(readRemembered(memoryStorage({ [DEVICES_KEY]: '{nope' }))).toEqual({})
    expect(readRemembered(memoryStorage({ [DEVICES_KEY]: '{"audioinput":5}' }))).toEqual({})
    expect(err).toHaveBeenCalledTimes(2)
    err.mockRestore()
  })
})

describe('selectedDevice', () => {
  const list = [
    { id: 'default', label: 'Default' },
    { id: 'mic-2', label: 'USB Headset' },
  ]
  it('the device in use when it is listed', () => {
    expect(selectedDevice(list, 'mic-2')).toBe('mic-2')
  })
  it('in use but not listed (or unknown): the browser default when listed, else the first', () => {
    expect(selectedDevice(list, 'gone')).toBe('default')
    expect(selectedDevice(list, null)).toBe('default')
    expect(selectedDevice([{ id: 'cam-1', label: 'Camera 1' }], null)).toBe('cam-1')
  })
  it('nothing listed: nothing selected', () => {
    expect(selectedDevice([], 'mic-2')).toBeNull()
  })
})
