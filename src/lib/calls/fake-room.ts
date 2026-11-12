import type { CallEnv, MediaDevicesLike } from './active-call.svelte'
import type { CallParticipant, Device, MediaFailure } from './call-state'
import type { CallDto, CallTokenDto } from './client'
import type { DeviceInfo, DeviceKind, DeviceStorage } from './devices'
import { MediaError, type CallRoom, type RoomSignal } from './room'

/**
 * Test doubles for the live call (unit + component specs only): a room with
 * no server, devices the spec lists, storage in memory. The spec decides who
 * is in the room and what the devices do.
 */

const stream = () => (typeof MediaStream === 'undefined' ? null : new MediaStream())

export class FakeRoom implements CallRoom {
  connectedWith: [string, string] | null = null
  disconnects = 0
  devices: Record<Device, boolean> = { microphone: false, camera: false, screen: false }
  failures: Partial<Record<Device, MediaFailure>> = {}
  remote: CallParticipant[] = []
  active: Partial<Record<DeviceKind, string>> = {}
  switches: Array<[DeviceKind, string]> = []
  switchFailure: Partial<Record<DeviceKind, string>> = {}
  /** Resolves connect() when the spec says so (null: at once). */
  holdConnect: Promise<void> | null = null
  private readonly listeners = new Set<(s: RoomSignal) => void>()
  readonly cameraStream = stream()
  readonly screenStream = stream()

  async connect(url: string, token: string) {
    if (this.holdConnect) await this.holdConnect
    this.connectedWith = [url, token]
  }
  async disconnect() {
    this.disconnects++
    this.emit({ type: 'disconnected', reason: 'hung_up' })
  }
  async setDevice(device: Device, on: boolean) {
    const failure = this.failures[device]
    if (on && failure) throw new MediaError(failure, `${device} failed`)
    this.devices[device] = on
    this.emit({ type: 'participants' })
  }
  async switchDevice(kind: DeviceKind, deviceId: string) {
    const failure = this.switchFailure[kind]
    if (failure) throw new Error(failure)
    this.switches.push([kind, deviceId])
    this.active[kind] = deviceId
  }
  activeDevice(kind: DeviceKind) {
    return this.active[kind] ?? null
  }
  async startAudio() {}
  participants(): CallParticipant[] {
    const me: CallParticipant = {
      identity: 'ann',
      name: 'Ann Example',
      isLocal: true,
      micOn: this.devices.microphone,
      cameraOn: this.devices.camera,
      speaking: false,
      camera: this.devices.camera ? this.cameraStream : null,
      screen: this.devices.screen ? this.screenStream : null,
    }
    return this.connectedWith ? [me, ...this.remote] : []
  }
  on(fn: (s: RoomSignal) => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  emit(s: RoomSignal) {
    for (const fn of [...this.listeners]) fn(s)
  }
  get listening() {
    return this.listeners.size
  }
}

export class FakeMedia implements MediaDevicesLike {
  list: DeviceInfo[]
  private readonly fns = new Set<() => void>()
  constructor(list: DeviceInfo[] = defaultDevices()) {
    this.list = list
  }
  async enumerateDevices() {
    return this.list
  }
  addEventListener(_type: 'devicechange', fn: () => void) {
    this.fns.add(fn)
  }
  removeEventListener(_type: 'devicechange', fn: () => void) {
    this.fns.delete(fn)
  }
  change(list: DeviceInfo[]) {
    this.list = list
    for (const fn of [...this.fns]) fn()
  }
  get listening() {
    return this.fns.size
  }
}

export const defaultDevices = (): DeviceInfo[] => [
  { kind: 'audioinput', deviceId: 'default', label: 'Default microphone' },
  { kind: 'audioinput', deviceId: 'mic-usb', label: 'USB Headset' },
  { kind: 'audiooutput', deviceId: 'default', label: 'Default speakers' },
  { kind: 'audiooutput', deviceId: 'spk-usb', label: 'USB Headset speakers' },
  { kind: 'videoinput', deviceId: 'cam-1', label: 'Built-in camera' },
  { kind: 'videoinput', deviceId: 'cam-2', label: 'Desk camera' },
]

export class FakeWindow {
  private readonly fns = new Set<() => void>()
  addEventListener(_type: 'pagehide', fn: () => void) {
    this.fns.add(fn)
  }
  removeEventListener(_type: 'pagehide', fn: () => void) {
    this.fns.delete(fn)
  }
  pagehide() {
    for (const fn of [...this.fns]) fn()
  }
  get listening() {
    return this.fns.size
  }
}

export function memoryStorage(initial: Record<string, string> = {}): DeviceStorage & { data: Record<string, string> } {
  const data = { ...initial }
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) }
}

export function fakeEnv(over: Partial<CallEnv> = {}): CallEnv & { win: FakeWindow; media: FakeMedia } {
  return {
    win: new FakeWindow(),
    media: new FakeMedia(),
    storage: memoryStorage(),
    canChooseSpeaker: true,
    canShareScreen: true,
    ...over,
  } as CallEnv & { win: FakeWindow; media: FakeMedia }
}

export const fakeCall = (over: Partial<CallDto> = {}, response: 'accepted' | 'none' = 'accepted'): CallDto => ({
  id: 'call-1',
  contextKind: 'dm',
  contextId: 'dm-1',
  title: 'Ann Example, Ben Example',
  startedBy: 'ben',
  startedByName: 'Ben Example',
  state: 'ringing',
  startedAt: '2026-11-11T09:00:00.000Z',
  answeredAt: null,
  endedAt: null,
  ringUntil: '2026-11-11T09:00:45.000Z',
  participants: [
    { userId: 'ben', name: 'Ben Example', response: 'accepted', joinedAt: null, leftAt: null, inRoom: false },
    { userId: 'ann', name: 'Ann Example', response, joinedAt: null, leftAt: null, inRoom: false },
  ],
  ...over,
})

export const fakeToken: CallTokenDto = {
  url: 'wss://rtc.example.test',
  room: 'ee-call-call-1',
  identity: 'ann',
  token: 'tok',
  expiresAt: '2026-11-11T09:10:00.000Z',
}

export const remotePerson = (over: Partial<CallParticipant> = {}): CallParticipant => ({
  identity: 'ben',
  name: 'Ben Example',
  isLocal: false,
  micOn: false,
  cameraOn: true,
  speaking: false,
  camera: stream(),
  screen: null,
  ...over,
})
