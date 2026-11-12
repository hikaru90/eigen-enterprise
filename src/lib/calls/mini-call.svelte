<script lang="ts">
  import type { ActiveCall } from './active-call.svelte'
  import type { LiveCalls } from './live-calls.svelte'
  import Maximize2 from '@lucide/svelte/icons/maximize-2'
  import Mic from '@lucide/svelte/icons/mic'
  import MicOff from '@lucide/svelte/icons/mic-off'
  import PhoneOff from '@lucide/svelte/icons/phone-off'
  import Settings2 from '@lucide/svelte/icons/settings-2'
  import Video from '@lucide/svelte/icons/video'
  import VideoOff from '@lucide/svelte/icons/video-off'
  import X from '@lucide/svelte/icons/x'
  import { onDestroy, onMount } from 'svelte'
  import UserAvatar from '$lib/components/user-avatar.svelte'
  import DevicePicker from './device-picker.svelte'
  import { callClock } from './format'

  /**
   * The docked mini call (Contribute round 4): on every nucleus page except
   * the call's own page, while I am in a call. Who is in it, how long it has
   * run, mute, camera, devices, hang up, and "Back to call". When the call
   * ends while I am elsewhere it says so until dismissed.
   */
  let {
    active,
    live,
    hidden,
    onopen,
  }: {
    active: ActiveCall
    /** The call feed: the call's answeredAt (its duration starts there). */
    live: LiveCalls
    /** On the call's own page: the page shows it. */
    hidden: boolean
    onopen: (callId: string) => void
  } = $props()

  let now = $state(Date.now())
  let devicesOpen = $state(false)
  let timer: ReturnType<typeof setInterval> | undefined
  onMount(() => {
    timer = setInterval(() => (now = Date.now()), 1000)
  })
  onDestroy(() => clearInterval(timer))

  const call = $derived(active.call)
  const s = $derived(active.state)
  const others = $derived(active.participants.filter((p) => !p.isLocal))
  const answeredAt = $derived(call ? (live.calls.find((c) => c.id === call.id)?.answeredAt ?? call.answeredAt) : null)
  const status = $derived(
    s.phase === 'connecting'
      ? 'Connecting…'
      : s.phase === 'reconnecting'
        ? 'Reconnecting…'
        : others.length === 0
          ? 'Waiting for others…'
          : answeredAt
            ? callClock((now - Date.parse(answeredAt)) / 1000)
            : 'In the call',
  )
  const who = $derived(others.length === 0 ? 'Only you' : others.map((p) => p.name).join(', '))
  const endedText = $derived(
    s.phase === 'error'
      ? (s.problem?.message ?? 'The call could not start.')
      : s.ended === 'connection_lost'
        ? 'The connection to the call was lost.'
        : s.ended === 'joined_elsewhere'
          ? 'You joined this call from another tab or device.'
          : 'The call has ended.',
  )

  async function hangUp() {
    devicesOpen = false
    await active.hangUp()
    active.release()
  }

  function toggleDevices() {
    devicesOpen = !devicesOpen
    if (devicesOpen) void active.refreshDevices()
  }

  const round = 'grid size-9 shrink-0 place-items-center rounded-full transition-colors disabled:opacity-50'
</script>

{#if call && !hidden}
  <div
    class="fixed inset-x-2 bottom-[max(0.5rem,env(safe-area-inset-bottom))] z-50 sm:inset-x-auto sm:right-5 sm:bottom-5 sm:w-96"
    role="region"
    aria-label="Your call"
    data-testid="mini-call"
    data-call-id={call.id}
    data-phase={s.phase}
  >
    {#if devicesOpen && active.inCall}
      <div class="mb-2">
        <DevicePicker {active} onclose={() => (devicesOpen = false)} />
      </div>
    {/if}
    <div class="rounded-xl border border-white/10 bg-neutral-950 p-3 text-neutral-50 shadow-2xl">
      {#if active.inCall}
        <div class="flex items-center gap-2">
          <span class="size-2 shrink-0 animate-pulse rounded-full bg-emerald-400" aria-hidden="true"></span>
          <p class="min-w-0 flex-1 truncate text-sm font-semibold" data-testid="mini-call-title">{call.title}</p>
          <span class="shrink-0 text-xs text-neutral-400 tabular-nums" data-testid="mini-call-status">{status}</span>
        </div>
        <div class="mt-2 flex items-center gap-2" data-testid="mini-call-people" data-count={active.participants.length}>
          <span class="flex shrink-0 -space-x-1.5" aria-hidden="true">
            {#each active.participants.slice(0, 4) as p (p.identity)}
              <span class={['rounded-full ring-2', p.speaking ? 'ring-emerald-400' : 'ring-neutral-950']}>
                <UserAvatar name={p.name} size="sm" round class="bg-neutral-700! text-white!" />
              </span>
            {/each}
          </span>
          <p class="min-w-0 flex-1 truncate text-xs text-neutral-300" data-testid="mini-call-who">{who}</p>
        </div>
        <div class="mt-3 flex items-center gap-2">
          <button
            type="button"
            class={[round, s.mic ? 'bg-white/15 hover:bg-white/25' : 'bg-white text-neutral-900 hover:bg-white/90']}
            aria-label={s.mic ? 'Mute' : 'Unmute'}
            title={s.mic ? 'Mute' : 'Unmute'}
            aria-pressed={!s.mic}
            disabled={s.phase !== 'connected'}
            data-testid="mini-call-mic"
            data-on={s.mic ? 'true' : 'false'}
            onclick={() => active.turn('microphone', !s.mic)}
            >{#if s.mic}<Mic class="size-4" />{:else}<MicOff class="size-4" />{/if}</button
          >
          <button
            type="button"
            class={[round, s.camera ? 'bg-white/15 hover:bg-white/25' : 'bg-white text-neutral-900 hover:bg-white/90']}
            aria-label={s.camera ? 'Turn camera off' : 'Turn camera on'}
            title={s.camera ? 'Turn camera off' : 'Turn camera on'}
            aria-pressed={!s.camera}
            disabled={s.phase !== 'connected'}
            data-testid="mini-call-camera"
            data-on={s.camera ? 'true' : 'false'}
            onclick={() => active.turn('camera', !s.camera)}
            >{#if s.camera}<Video class="size-4" />{:else}<VideoOff class="size-4" />{/if}</button
          >
          <button
            type="button"
            class={[round, devicesOpen ? 'bg-white text-neutral-900 hover:bg-white/90' : 'bg-white/15 hover:bg-white/25']}
            aria-label="Devices"
            title="Microphone, speaker and camera"
            aria-expanded={devicesOpen}
            disabled={s.phase !== 'connected'}
            data-testid="mini-call-devices-toggle"
            onclick={toggleDevices}><Settings2 class="size-4" /></button
          >
          <button
            type="button"
            class="flex h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full bg-white/15 px-3 text-xs font-semibold hover:bg-white/25"
            data-testid="mini-call-back"
            onclick={() => onopen(call.id)}><Maximize2 class="size-3.5 shrink-0" aria-hidden="true" /><span class="truncate">Back to call</span></button
          >
          <button
            type="button"
            class="grid h-9 w-12 shrink-0 place-items-center rounded-full bg-red-600 text-white hover:bg-red-700"
            aria-label="Hang up"
            title="Hang up"
            data-testid="mini-call-hangup"
            onclick={hangUp}><PhoneOff class="size-4" /></button
          >
        </div>
      {:else}
        <div class="flex items-start gap-2" role="status">
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold">{call.title}</p>
            <p class="text-xs text-neutral-300" data-testid="mini-call-ended">{endedText}</p>
          </div>
          {#if s.ended === 'connection_lost' || s.ended === 'joined_elsewhere'}
            <button
              type="button"
              class="h-8 shrink-0 rounded-full bg-white px-3 text-xs font-semibold text-neutral-900 hover:bg-white/90"
              data-testid="mini-call-rejoin"
              onclick={() => active.rejoin()}>Rejoin</button
            >
          {/if}
          <button
            type="button"
            class="grid size-8 shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-white/10 hover:text-white"
            aria-label="Dismiss"
            data-testid="mini-call-dismiss"
            onclick={() => active.release()}><X class="size-4" /></button
          >
        </div>
      {/if}
    </div>
  </div>
{/if}
