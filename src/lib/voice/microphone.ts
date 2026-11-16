/**
 * Opening the microphone for voice (dictation, voice messages, the voice input button):
 * the microphone chosen for this browser — the same choice calls use (`$lib/calls/devices`).
 *
 * Nothing chosen → the browser's default microphone. Chosen → exactly that device; when it is
 * gone (OverconstrainedError / NotFoundError) the error names it and says where to choose
 * another. It never records from a different microphone than the one chosen.
 */
import { deviceOptions, micConstraints, readRemembered, type DeviceInfo, type DeviceStorage } from '$lib/calls/devices'

export type MicrophoneDeps = {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  /** Only read when the chosen microphone failed, to name it. */
  enumerateDevices: () => Promise<DeviceInfo[]>
  /** null: this browser has no storage, so nothing can have been chosen. */
  storage: DeviceStorage | null
}

/** The chosen device could not be opened: the browser's own errors for a missing / unmatched device. */
const CHOSEN_GONE = new Set(['OverconstrainedError', 'NotFoundError'])

export function chosenMicrophoneMessage(label: string | null): string {
  const where = 'Choose another under Audio devices in the settings menu.'
  return label
    ? `The chosen microphone (${label}) is not available. ${where}`
    : `The chosen microphone is not connected. ${where}`
}

export class ChosenMicrophoneUnavailable extends Error {
  override name = 'ChosenMicrophoneUnavailable'
  constructor(
    /** The device's name as the browser lists it; null when it is no longer listed. */
    readonly label: string | null,
    options?: ErrorOptions,
  ) {
    super(chosenMicrophoneMessage(label), options)
  }
}

const errorName = (err: unknown) => (err !== null && typeof err === 'object' && 'name' in err ? String(err.name) : '')

/**
 * The stream from the chosen microphone. getUserMedia is called synchronously (before any
 * await), so callers that must stay inside the tap keep doing so.
 */
export async function openMicrophone(deps: MicrophoneDeps): Promise<MediaStream> {
  const remembered = deps.storage ? readRemembered(deps.storage) : {}
  const id = remembered.audioinput
  try {
    return await deps.getUserMedia(micConstraints(remembered))
  } catch (err) {
    if (!id || !CHOSEN_GONE.has(errorName(err))) throw err
    let label: string | null = null
    try {
      label = deviceOptions(await deps.enumerateDevices()).audioinput.find((d) => d.id === id)?.label ?? null
    } catch (listErr) {
      console.error('[voice] listing microphones to name the chosen one failed', listErr)
    }
    throw new ChosenMicrophoneUnavailable(label, { cause: err })
  }
}

/** The browser's storage, or null where there is none (SSR, a locked-down browser). */
export function browserDeviceStorage(): DeviceStorage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

/** The real browser APIs, read at call time. */
export function browserMicrophoneDeps(): MicrophoneDeps {
  return {
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    enumerateDevices: () => navigator.mediaDevices.enumerateDevices(),
    storage: browserDeviceStorage(),
  }
}
