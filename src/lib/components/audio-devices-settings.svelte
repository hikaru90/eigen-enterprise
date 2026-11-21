<script lang="ts" module>
  import type { DeviceInfo, DeviceStorage } from '$lib/calls/devices'

  export type AudioDevicesEnv = {
    /** null: this browser offers no media devices API (e.g. not a secure context). */
    media: {
      enumerateDevices(): Promise<DeviceInfo[]>
      getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>
      addEventListener(type: 'devicechange', fn: () => void): void
      removeEventListener(type: 'devicechange', fn: () => void): void
    } | null
    storage: DeviceStorage
    /** The browser can route sound to a chosen speaker (HTMLMediaElement.setSinkId). */
    canChooseSpeaker: boolean
  }

  export function browserAudioDevicesEnv(): AudioDevicesEnv {
    return {
      media:
        typeof navigator !== 'undefined' && navigator.mediaDevices ? navigator.mediaDevices : null,
      storage: window.localStorage,
      canChooseSpeaker:
        typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype,
    }
  }
</script>

<script lang="ts">
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { onDestroy, onMount } from 'svelte'
  import {
    deviceOptions,
    emptyDeviceLists,
    forget,
    readRemembered,
    remember,
    type DeviceLists,
    type Remembered,
  } from '$lib/calls/devices'

  /**
   * Microphone + speaker for this browser, outside calls (settings menu → Audio devices).
   * ONE choice shared with calls (`ee.calls.devices`): the mic dictation, voice messages and
   * the voice input button record from, and the speaker the assistant's voice plays on.
   * "System default" means no choice (the browser decides). Browsers list device names only
   * after microphone permission: until then this says so and offers to ask once. The lists
   * refresh on devicechange (listener added on mount, removed on destroy).
   */
  let { env = browserAudioDevicesEnv() }: { env?: AudioDevicesEnv } = $props()

  const DEFAULT = ''
  let lists = $state<DeviceLists>(emptyDeviceLists())
  let remembered = $state<Remembered>({})
  /** No device names yet: the browser hides them until microphone permission. */
  let unlabelled = $state(false)
  let loaded = $state(false)
  let asking = $state(false)
  let problem = $state<string | null>(null)

  async function refresh(): Promise<void> {
    const media = env.media
    if (!media) return
    try {
      const infos = await media.enumerateDevices()
      lists = deviceOptions(infos)
      unlabelled = !infos.some(
        (d) => (d.kind === 'audioinput' || d.kind === 'audiooutput') && d.label,
      )
      remembered = readRemembered(env.storage)
    } catch (err) {
      console.error('[devices] listing audio devices failed', err)
      problem = `Could not list your devices: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      loaded = true
    }
  }

  const onDeviceChange = () => void refresh()

  onMount(() => {
    env.media?.addEventListener('devicechange', onDeviceChange)
    void refresh()
  })
  onDestroy(() => {
    env.media?.removeEventListener('devicechange', onDeviceChange)
  })

  async function allowMicrophone(): Promise<void> {
    const media = env.media
    if (!media || asking) return
    asking = true
    problem = null
    try {
      const stream = await media.getUserMedia({ audio: true })
      for (const track of stream.getTracks()) track.stop()
      await refresh()
    } catch (err) {
      const name = err !== null && typeof err === 'object' && 'name' in err ? String(err.name) : ''
      problem =
        name === 'NotAllowedError'
          ? 'Microphone permission denied. Allow it in your browser’s site settings to see your devices.'
          : `Could not open the microphone: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      asking = false
    }
  }

  function choose(kind: 'audioinput' | 'audiooutput', id: string): void {
    problem = null
    try {
      if (id === DEFAULT) forget(env.storage, kind)
      else remember(env.storage, kind, id)
      remembered = readRemembered(env.storage)
    } catch (err) {
      console.error('[devices] remembering the audio device failed', err)
      problem = `Could not remember the device: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  /** The chosen device is remembered but not plugged in now. */
  const missing = $derived({
    audioinput:
      !!remembered.audioinput && !lists.audioinput.some((d) => d.id === remembered.audioinput),
    audiooutput:
      !!remembered.audiooutput && !lists.audiooutput.some((d) => d.id === remembered.audiooutput),
  })

  const ROWS = [
    { kind: 'audioinput', label: 'Microphone', noun: 'microphone' },
    { kind: 'audiooutput', label: 'Speaker', noun: 'speaker' },
  ] as const

  const selectClass =
    'border-border bg-background text-foreground h-8 w-full min-w-0 truncate rounded-sm border px-1.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
  const noteClass = 'text-muted-foreground text-xs leading-relaxed'
</script>

<div
  class="flex flex-col gap-2.5 px-2 pt-1 pb-1.5"
  role="group"
  aria-label="Audio devices"
  data-testid="audio-devices"
>
  {#if !env.media}
    <p class={noteClass} data-testid="audio-devices-unavailable">
      This browser offers no device choice here.
    </p>
  {:else}
    {#if loaded && unlabelled}
      <div class="flex flex-col gap-1.5">
        <p class={noteClass}>Your browser shows device names after you allow the microphone.</p>
        <button
          type="button"
          class="border-border text-foreground hover:bg-white/25 dark:hover:bg-white/10 h-7 cursor-pointer rounded-sm border px-2 text-xs disabled:opacity-50"
          disabled={asking}
          onclick={() => void allowMicrophone()}
          data-testid="audio-devices-allow"
        >
          Allow microphone to see devices
        </button>
      </div>
    {/if}
    {#each ROWS as row (row.kind)}
      <div class="flex flex-col gap-1">
        <label for="audio-device-{row.kind}" class="text-muted-foreground text-xs font-medium"
          >{row.label}</label
        >
        {#if row.kind === 'audiooutput' && !env.canChooseSpeaker}
          <p class={noteClass} data-testid="audio-speaker-unsupported">
            This browser cannot choose the speaker. Sound plays on your device's current output;
            change it in your system's sound settings.
          </p>
        {:else}
          <select
            id="audio-device-{row.kind}"
            class={selectClass}
            value={remembered[row.kind] ?? DEFAULT}
            onchange={(e) => choose(row.kind, e.currentTarget.value)}
            data-testid="audio-device-{row.kind}"
          >
            <option value={DEFAULT}>System default</option>
            {#if missing[row.kind]}
              <option value={remembered[row.kind]}>Chosen {row.noun} (not connected)</option>
            {/if}
            {#each lists[row.kind] as d (d.id)}
              <option value={d.id}>{d.label}</option>
            {/each}
          </select>
          {#if missing[row.kind]}
            <p class={noteClass} data-testid="audio-device-missing" data-kind={row.kind}>
              Your chosen {row.noun} is not connected. Plug it in or choose another.
            </p>
          {/if}
        {/if}
      </div>
    {/each}
  {/if}
  {#if problem}
    <ErrorNotice
      class="text-xs leading-relaxed"
      testid="audio-devices-problem"
      error={problem}
      attempted="Listing, testing or remembering the audio devices in Settings (browser media devices API)"
    />
  {/if}
</div>
