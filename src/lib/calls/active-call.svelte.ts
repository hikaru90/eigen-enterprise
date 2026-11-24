import {
  callReducer,
  initialCallState,
  type CallEvent,
  type CallParticipant,
  type CallViewState,
  type Device,
} from './call-state'
import { problemOf, type CallDto, type CallsClient } from './client'
import {
  DEVICE_KINDS,
  deviceNoun,
  deviceOptions,
  emptyDeviceLists,
  readRemembered,
  remember,
  selectedDevice,
  type DeviceInfo,
  type DeviceKind,
  type DeviceLists,
  type DeviceStorage,
} from './devices'
import { nextSpeaker } from './layout'
import { DEFAULT_MEDIA, readMedia, saveMedia, type MediaSettings } from './media-settings'
import { MediaError, type CallRoom, type RoomSignal } from './room'

/**
 * The live call of one call tab. A call always runs in its own browser tab
 * (call-tab.ts; owner, 2026-11-16): the call page owns ONE ActiveCall, and
 * the tab cannot be navigated away from while the call is live, so the main
 * instance stays clean. (Before, the nucleus layout owned it and a docked
 * mini call followed the person around the app — Contribute round 4.)
 *
 * The call ends only by: the hang-up button (hangUp), the tab closing or
 * being left (pagehide → keepalive hang-up), the call page going away
 * (close), or the call ending on the server. One call at a time in a tab:
 * opening another while in one is refused ('busy'); across tabs, the call
 * tab tells the others (call-presence.svelte.ts, fed by subscribe).
 *
 * Media goes through the injected CallRoom (LiveKit in the app, a fake in
 * specs); the browser bits (window, mediaDevices, storage) come from `env`,
 * read when a call starts — never during SSR.
 */

export type MediaDevicesLike = {
  enumerateDevices(): Promise<DeviceInfo[]>
  addEventListener(type: 'devicechange', fn: () => void): void
  removeEventListener(type: 'devicechange', fn: () => void): void
}

export type CallEnv = {
  win: {
    addEventListener(type: 'pagehide', fn: () => void): void
    removeEventListener(type: 'pagehide', fn: () => void): void
  }
  /** null: this browser offers no media devices API (e.g. not a secure context). */
  media: MediaDevicesLike | null
  storage: DeviceStorage
  /** The browser can route call sound to a chosen speaker (HTMLMediaElement.setSinkId). */
  canChooseSpeaker: boolean
  canShareScreen: boolean
}

export type ActiveCallDeps = {
  client: Pick<CallsClient, 'accept' | 'token' | 'hangup' | 'get'>
  createRoom: () => Promise<CallRoom>
  env: () => CallEnv
}

export type OpenResult = 'joining' | 'here' | 'busy'

export type StartWith = { microphone: boolean; camera: boolean }

type Selected = Record<DeviceKind, string | null>
const noneSelected = (): Selected => ({ audioinput: null, audiooutput: null, videoinput: null })

export class ActiveCall {
  #call = $state<CallDto | null>(null)
  #s = $state<CallViewState>(initialCallState)
  #participants = $state<CallParticipant[]>([])
  #audioBlocked = $state(false)
  /** The call as the server ended it (shown after LiveKit closed the room). */
  #finalState = $state<CallDto['state'] | null>(null)
  #speaker = $state<string | null>(null)
  #devices = $state<DeviceLists>(emptyDeviceLists())
  #selected = $state<Selected>(noneSelected())
  #deviceProblem = $state<string | null>(null)
  #media = $state<MediaSettings>({ ...DEFAULT_MEDIA })
  #canChooseSpeaker = $state(false)
  #canShareScreen = $state(false)

  readonly #deps: ActiveCallDeps
  #env: CallEnv | null = null
  #me = ''
  /** Which devices turn on once connected (a guest's choice on the preview; otherwise both). */
  #startWith: StartWith = { microphone: true, camera: true }
  #room: CallRoom | null = null
  #unsubscribe = () => {}
  /** Each join gets a number; a join that is no longer the current one stops (hung up mid-join). */
  #attempt = 0
  /** /hangup was sent for the current call: never twice. */
  #hungUp = false
  #listening = false
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- subscriber callbacks are never rendered
  #listeners = new Set<() => void>()

  constructor(deps: ActiveCallDeps) {
    this.#deps = deps
  }

  get call() {
    return this.#call
  }
  get state() {
    return this.#s
  }
  get participants() {
    return this.#participants
  }
  get audioBlocked() {
    return this.#audioBlocked
  }
  get finalState() {
    return this.#finalState
  }
  /** The remote person speaking now (or last), emphasised in the grid. */
  get speaker() {
    return this.#speaker
  }
  /** Video quality and noise cancellation, as this browser remembers them. */
  get media() {
    return this.#media
  }
  get devices() {
    return this.#devices
  }
  get selected() {
    return this.#selected
  }
  /** A device that did not switch, in words; null while fine. */
  get deviceProblem() {
    return this.#deviceProblem
  }
  get canChooseSpeaker() {
    return this.#canChooseSpeaker
  }
  get canShareScreen() {
    return this.#canShareScreen
  }
  /** Joining or in the call (not ended, not failed). */
  get inCall() {
    const p = this.#s.phase
    return this.#call !== null && (p === 'connecting' || p === 'connected' || p === 'reconnecting')
  }

  /** Called after every change of the call or its phase (call presence across tabs — no effect needed). */
  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  /**
   * The call page asks to show this call. In it already → 'here'; in another
   * one → 'busy' (nothing changes); otherwise it joins this one.
   */
  open(
    call: CallDto,
    me: string,
    startWith: StartWith = { microphone: true, camera: true },
  ): OpenResult {
    if (this.inCall && this.#call) return this.#call.id === call.id ? 'here' : 'busy'
    this.#forget()
    this.#call = call
    this.#me = me
    this.#startWith = startWith
    this.#notify()
    void this.#join()
    return 'joining'
  }

  /** The hang-up button: leave the room and tell the server. */
  hangUp(): Promise<void> {
    return this.#leave(false)
  }

  /** Join the same call again after a lost connection or a problem. */
  rejoin(): void {
    const call = this.#call
    if (!call || this.inCall) return
    this.#detachRoom()
    this.#dispatch({ type: 'retry' })
    this.#hungUp = false
    this.#finalState = null
    void this.#join()
  }

  /**
   * A newer view of this call from the server (the call feed, a refresh, a
   * transcription switch): when someone answered (the call's clock), who is
   * transcribed. Another call's view is ignored.
   */
  update(call: CallDto): void {
    if (this.#call?.id !== call.id) return
    this.#call = call
    this.#notify()
  }

  /** Ask the server for this call now (a guest has no call feed). */
  async refresh(): Promise<void> {
    const call = this.#call
    if (!call) return
    this.update(await this.#deps.client.get(call.id))
  }

  /** My microphone as the room publishes it; null while it is off or I am in no room. */
  microphoneTrack(): MediaStreamTrack | null {
    return this.#room ? this.#room.microphoneTrack() : null
  }

  /** Forget a call that is over (its view was closed). A live call stays. */
  release(): void {
    if (!this.inCall) this.#forget()
  }

  /** The nucleus layout went away: leave like closing the tab. */
  close(): void {
    void this.#leave(true)
  }

  async turn(device: Device, on: boolean): Promise<void> {
    const room = this.#room
    if (!room) return
    try {
      await room.setDevice(device, on)
      this.#dispatch({ type: 'media', device, on })
    } catch (err) {
      if (err instanceof MediaError)
        this.#dispatch({ type: 'media_failed', device, failure: err.failure, detail: err.message })
      else
        this.#dispatch({
          type: 'media_failed',
          device,
          failure: 'other',
          detail: err instanceof Error ? err.message : String(err),
        })
    }
    if (on && device !== 'screen') await this.refreshDevices()
  }

  /** Use this microphone / speaker / camera from now on, and remember it for this browser. */
  async chooseDevice(kind: DeviceKind, id: string): Promise<void> {
    const room = this.#room
    if (!room || !this.#env) return
    if (kind === 'audiooutput' && !this.#canChooseSpeaker) return
    this.#deviceProblem = null
    try {
      await room.switchDevice(kind, id)
    } catch (err) {
      const label = this.#devices[kind].find((d) => d.id === id)?.label ?? id
      this.#deviceProblem = `Could not switch the ${deviceNoun(kind).toLowerCase()} to ${label}: ${err instanceof Error ? err.message : String(err)}`
      return
    }
    this.#selected = { ...this.#selected, [kind]: id }
    try {
      remember(this.#env.storage, kind, id)
    } catch (err) {
      console.error('[calls] remembering the call device failed', err)
    }
  }

  /** Change video quality and/or noise cancellation: applied to the room now, remembered for this browser. */
  async setMedia(patch: Partial<MediaSettings>): Promise<void> {
    const room = this.#room
    if (!room || !this.#env) return
    this.#deviceProblem = null
    const next = { ...this.#media, ...patch }
    try {
      await room.applyMedia(next)
    } catch (err) {
      this.#deviceProblem = `Could not change the call quality: ${err instanceof Error ? err.message : String(err)}`
      return
    }
    this.#media = next
    try {
      saveMedia(this.#env.storage, patch)
    } catch (err) {
      console.error('[calls] remembering the call media settings failed', err)
    }
  }

  /** Read the device lists again (on devicechange, after a device turned on). */
  async refreshDevices(): Promise<void> {
    const media = this.#env?.media
    if (!media) return
    let infos: DeviceInfo[]
    try {
      infos = await media.enumerateDevices()
    } catch (err) {
      console.error('[calls] listing media devices failed', err)
      this.#deviceProblem = `Could not list your devices: ${err instanceof Error ? err.message : String(err)}`
      return
    }
    const lists = deviceOptions(infos)
    const room = this.#room
    const selected = noneSelected()
    for (const kind of DEVICE_KINDS)
      selected[kind] = selectedDevice(lists[kind], room ? room.activeDevice(kind) : null)
    this.#devices = lists
    this.#selected = selected
  }

  dismissNotice(device: Device): void {
    this.#dispatch({ type: 'dismiss_notice', device })
  }

  dismissDeviceProblem(): void {
    this.#deviceProblem = null
  }

  startAudio(): void {
    this.#room
      ?.startAudio()
      .catch((err: unknown) => console.error('[calls] starting audio failed', err))
  }

  // ── internals ────────────────────────────────────────────────────────────

  readonly #onPageHide = () => void this.#leave(true)
  readonly #onDeviceChange = () => void this.refreshDevices()

  #dispatch(e: CallEvent) {
    this.#s = callReducer(this.#s, e)
    this.#notify()
  }

  #notify() {
    for (const fn of [...this.#listeners]) fn()
  }

  #refresh() {
    this.#participants = this.#room ? this.#room.participants() : []
    this.#speaker = nextSpeaker(this.#speaker, this.#participants)
  }

  readonly #onSignal = (sig: RoomSignal) => {
    switch (sig.type) {
      case 'participants':
        return this.#refresh()
      case 'reconnecting':
      case 'reconnected':
        return this.#dispatch({ type: sig.type })
      case 'media':
        return this.#dispatch({ type: 'media', device: sig.device, on: sig.on })
      case 'audio':
        this.#audioBlocked = sig.blocked
        return
      case 'disconnected': {
        this.#dispatch({ type: 'disconnected', reason: sig.reason })
        this.#participants = []
        this.#speaker = null
        this.#audioBlocked = false
        this.#stopListening()
        const call = this.#call
        if (sig.reason === 'call_over' && call) {
          this.#deps.client
            .get(call.id)
            .then((c) => {
              if (this.#call?.id === c.id) this.#finalState = c.state
            })
            .catch((err: unknown) => console.error('[calls] loading the ended call failed', err))
        }
      }
    }
  }

  #listen(env: CallEnv) {
    if (this.#listening) return
    this.#listening = true
    env.win.addEventListener('pagehide', this.#onPageHide)
    env.media?.addEventListener('devicechange', this.#onDeviceChange)
  }

  #stopListening() {
    if (!this.#listening || !this.#env) return
    this.#listening = false
    this.#env.win.removeEventListener('pagehide', this.#onPageHide)
    this.#env.media?.removeEventListener('devicechange', this.#onDeviceChange)
  }

  #detachRoom() {
    this.#unsubscribe()
    this.#unsubscribe = () => {}
    this.#room = null
  }

  #forget() {
    this.#detachRoom()
    this.#attempt++
    this.#call = null
    this.#s = initialCallState
    this.#participants = []
    this.#speaker = null
    this.#audioBlocked = false
    this.#finalState = null
    this.#deviceProblem = null
    this.#hungUp = false
    this.#notify()
  }

  /** Switch to the remembered devices that are plugged in (before mic + camera turn on). */
  async #applyRemembered(room: CallRoom, env: CallEnv) {
    await this.refreshDevices()
    const remembered = readRemembered(env.storage)
    for (const kind of DEVICE_KINDS) {
      const id = remembered[kind]
      if (!id || !this.#devices[kind].some((d) => d.id === id)) continue
      if (kind === 'audiooutput' && !env.canChooseSpeaker) continue
      try {
        await room.switchDevice(kind, id)
        this.#selected = { ...this.#selected, [kind]: id }
      } catch (err) {
        console.error(`[calls] the remembered ${kind} could not be used`, err)
      }
    }
  }

  async #join() {
    const call = this.#call
    if (!call) return
    const attempt = ++this.#attempt
    const stale = () => attempt !== this.#attempt
    const env = (this.#env ??= this.#deps.env())
    this.#canChooseSpeaker = env.canChooseSpeaker
    this.#canShareScreen = env.canShareScreen
    this.#listen(env)
    let room: CallRoom
    try {
      const mine = call.participants.find((p) => p.userId === this.#me)
      if (!mine || mine.response !== 'accepted') await this.#deps.client.accept(call.id)
      const t = await this.#deps.client.token(call.id)
      if (stale()) return
      try {
        room = await this.#deps.createRoom()
      } catch (err) {
        throw new Error(
          `The call could not load (${err instanceof Error ? err.message : String(err)}). Reload the page.`,
          { cause: err },
        )
      }
      if (stale()) return
      this.#room = room
      this.#unsubscribe = room.on(this.#onSignal)
      try {
        await room.connect(t.url, t.token)
      } catch (err) {
        throw new Error(
          `could not connect to the call server (${err instanceof Error ? err.message : String(err)})`,
          { cause: err },
        )
      }
      if (stale()) {
        await room
          .disconnect()
          .catch((err: unknown) => console.error('[calls] leaving the room failed', err))
        return
      }
      this.#dispatch({ type: 'connected' })
      this.#refresh()
      await this.#applyRemembered(room, env)
      if (stale()) return
      this.#media = readMedia(env.storage)
      await room.applyMedia(this.#media)
      if (stale()) return
      if (this.#startWith.microphone) await this.turn('microphone', true)
      if (stale()) return
      if (this.#startWith.camera) await this.turn('camera', true)
    } catch (err) {
      if (stale()) return
      this.#detachRoom()
      this.#stopListening()
      this.#dispatch({ type: 'failed', problem: problemOf(err) })
    }
  }

  /** Leave the room and tell the server — once per call. */
  async #leave(keepalive: boolean): Promise<void> {
    const call = this.#call
    const room = this.#room
    const wasIn = this.inCall
    this.#attempt++
    this.#stopListening()
    if (wasIn) this.#dispatch({ type: 'disconnected', reason: 'hung_up' })
    this.#detachRoom()
    this.#participants = []
    this.#speaker = null
    const disconnecting = room
      ? room
          .disconnect()
          .catch((err: unknown) => console.error('[calls] leaving the room failed', err))
      : Promise.resolve()
    if (!call || !wasIn || this.#hungUp) {
      await disconnecting
      return
    }
    this.#hungUp = true
    const told = this.#deps.client
      .hangup(call.id, { keepalive })
      .catch((err: unknown) => console.error('[calls] hang up failed', err))
    await Promise.all([disconnecting, told])
  }
}

/** The browser's side of the env (read when the first call starts). */
export function browserCallEnv(): CallEnv {
  const media = navigator.mediaDevices ?? null
  return {
    win: window,
    media: media as MediaDevicesLike | null,
    storage: window.localStorage,
    canChooseSpeaker:
      typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype,
    canShareScreen: typeof media?.getDisplayMedia === 'function',
  }
}

/** The live call as the app runs it: livekit-client loaded on first use (it needs WebRTC). */
export function browserActiveCall(client: ActiveCallDeps['client']): ActiveCall {
  return new ActiveCall({
    client,
    createRoom: async () => (await import('./livekit-room')).createLiveKitRoom(),
    env: browserCallEnv,
  })
}
