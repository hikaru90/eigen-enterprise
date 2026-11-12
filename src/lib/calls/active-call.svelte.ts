import { getContext, setContext } from 'svelte'
import { callReducer, initialCallState, type CallEvent, type CallParticipant, type CallViewState, type Device } from './call-state'
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
import { MediaError, type CallRoom, type RoomSignal } from './room'

/**
 * The live call, above the pages (Contribute round 4: "I opened Email during
 * a call and it hung up"). The nucleus layout owns ONE ActiveCall; the call
 * page only shows it and the docked mini call shows it everywhere else, so
 * moving around the app never leaves the call.
 *
 * The call ends only by: the hang-up button (hangUp), the tab closing or
 * being left (pagehide → keepalive hang-up), the nucleus layout going away
 * (close), or the call ending on the server. One call at a time: opening
 * another while in one is refused ('busy') — the page says so plainly.
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
  win: { addEventListener(type: 'pagehide', fn: () => void): void; removeEventListener(type: 'pagehide', fn: () => void): void }
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
  #canChooseSpeaker = $state(false)
  #canShareScreen = $state(false)

  readonly #deps: ActiveCallDeps
  #env: CallEnv | null = null
  #me = ''
  #room: CallRoom | null = null
  #unsubscribe = () => {}
  /** Each join gets a number; a join that is no longer the current one stops (hung up mid-join). */
  #attempt = 0
  /** /hangup was sent for the current call: never twice. */
  #hungUp = false
  #listening = false

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

  /**
   * The call page asks to show this call. In it already → 'here'; in another
   * one → 'busy' (nothing changes); otherwise it joins this one.
   */
  open(call: CallDto, me: string): OpenResult {
    if (this.inCall && this.#call) return this.#call.id === call.id ? 'here' : 'busy'
    this.#forget()
    this.#call = call
    this.#me = me
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

  /** Forget a call that is over (its page or the mini call was closed). A live call stays. */
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
      if (err instanceof MediaError) this.#dispatch({ type: 'media_failed', device, failure: err.failure, detail: err.message })
      else this.#dispatch({ type: 'media_failed', device, failure: 'other', detail: err instanceof Error ? err.message : String(err) })
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
    for (const kind of DEVICE_KINDS) selected[kind] = selectedDevice(lists[kind], room ? room.activeDevice(kind) : null)
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
    this.#room?.startAudio().catch((err: unknown) => console.error('[calls] starting audio failed', err))
  }

  // ── internals ────────────────────────────────────────────────────────────

  readonly #onPageHide = () => void this.#leave(true)
  readonly #onDeviceChange = () => void this.refreshDevices()

  #dispatch(e: CallEvent) {
    this.#s = callReducer(this.#s, e)
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
        throw new Error(`The call could not load (${err instanceof Error ? err.message : String(err)}). Reload the page.`, { cause: err })
      }
      if (stale()) return
      this.#room = room
      this.#unsubscribe = room.on(this.#onSignal)
      try {
        await room.connect(t.url, t.token)
      } catch (err) {
        throw new Error(`could not connect to the call server (${err instanceof Error ? err.message : String(err)})`, { cause: err })
      }
      if (stale()) {
        await room.disconnect().catch((err: unknown) => console.error('[calls] leaving the room failed', err))
        return
      }
      this.#dispatch({ type: 'connected' })
      this.#refresh()
      await this.#applyRemembered(room, env)
      if (stale()) return
      await this.turn('microphone', true)
      if (stale()) return
      await this.turn('camera', true)
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
    const disconnecting = room ? room.disconnect().catch((err: unknown) => console.error('[calls] leaving the room failed', err)) : Promise.resolve()
    if (!call || !wasIn || this.#hungUp) {
      await disconnecting
      return
    }
    this.#hungUp = true
    const told = this.#deps.client.hangup(call.id, { keepalive }).catch((err: unknown) => console.error('[calls] hang up failed', err))
    await Promise.all([disconnecting, told])
  }
}

const KEY = Symbol('active-call')

/** The nucleus layout owns the live call; pages and components under it read it. */
export function setActiveCall(active: ActiveCall): ActiveCall {
  return setContext(KEY, active)
}

export function getActiveCall(): ActiveCall {
  const active = getContext<ActiveCall | undefined>(KEY)
  if (!active) throw new Error('calls: no live call — getActiveCall() works only under the nucleus layout')
  return active
}

/** For component specs: the context a component under the nucleus layout sees. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a Svelte mount `context` map, never rendered
export const activeCallContext = (active: ActiveCall) => new Map<unknown, unknown>([[KEY, active]])

/** The browser's side of the env (read when the first call starts). */
export function browserCallEnv(): CallEnv {
  const media = navigator.mediaDevices ?? null
  return {
    win: window,
    media: media as MediaDevicesLike | null,
    storage: window.localStorage,
    canChooseSpeaker: typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype,
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
