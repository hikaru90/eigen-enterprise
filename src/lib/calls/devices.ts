/**
 * Choosing the microphone, speaker and camera in a call (Contribute round 4).
 * Pure helpers: the list from `enumerateDevices`, the choice remembered per
 * browser (localStorage), and which entry the picker shows as selected.
 */

export type DeviceKind = 'audioinput' | 'audiooutput' | 'videoinput'
export const DEVICE_KINDS: readonly DeviceKind[] = ['audioinput', 'audiooutput', 'videoinput']

/** What the picker needs of a MediaDeviceInfo. */
export type DeviceInfo = { kind: MediaDeviceKind; deviceId: string; label: string }
export type DeviceOption = { id: string; label: string }
export type DeviceLists = Record<DeviceKind, DeviceOption[]>
export type Remembered = Partial<Record<DeviceKind, string>>
export type DeviceStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void }

export const DEVICES_KEY = 'ee.calls.devices'

const NOUN: Record<DeviceKind, string> = { audioinput: 'Microphone', audiooutput: 'Speaker', videoinput: 'Camera' }

export const emptyDeviceLists = (): DeviceLists => ({ audioinput: [], audiooutput: [], videoinput: [] })

/**
 * The devices by kind. Entries without an id are what the browser lists
 * before media permission is granted — nothing to choose yet, so left out.
 */
export function deviceOptions(infos: readonly DeviceInfo[]): DeviceLists {
  const out = emptyDeviceLists()
  for (const d of infos) {
    if (!(d.kind in out) || !d.deviceId) continue
    const list = out[d.kind as DeviceKind]
    if (list.some((o) => o.id === d.deviceId)) continue
    list.push({ id: d.deviceId, label: d.label || `${NOUN[d.kind as DeviceKind]} ${list.length + 1}` })
  }
  return out
}

/** The choices this browser remembers. A broken stored value is reported and ignored. */
export function readRemembered(storage: DeviceStorage): Remembered {
  const raw = storage.getItem(DEVICES_KEY)
  if (raw === null) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object')
    const out: Remembered = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (!(DEVICE_KINDS as readonly string[]).includes(k) || typeof v !== 'string') throw new Error(`bad entry ${k}`)
      out[k as DeviceKind] = v
    }
    return out
  } catch (err) {
    console.error(`[calls] the remembered call devices (${DEVICES_KEY}) are unreadable; choose them again`, err)
    return {}
  }
}

export function remember(storage: DeviceStorage, kind: DeviceKind, id: string): void {
  storage.setItem(DEVICES_KEY, JSON.stringify({ ...readRemembered(storage), [kind]: id }))
}

/** The entry the picker shows: the device in use, else the browser default, else the first one. */
export function selectedDevice(list: readonly DeviceOption[], inUse: string | null): string | null {
  if (list.length === 0) return null
  if (inUse && list.some((o) => o.id === inUse)) return inUse
  return list.find((o) => o.id === 'default')?.id ?? list[0].id
}

export const deviceNoun = (kind: DeviceKind) => NOUN[kind]
