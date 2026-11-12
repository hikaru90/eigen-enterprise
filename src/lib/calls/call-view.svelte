<script lang="ts">
  import type { ActiveCall } from './active-call.svelte'
  import type { CallDto } from './client'
  import Mic from '@lucide/svelte/icons/mic'
  import MicOff from '@lucide/svelte/icons/mic-off'
  import PhoneOff from '@lucide/svelte/icons/phone-off'
  import ScreenShare from '@lucide/svelte/icons/screen-share'
  import ScreenShareOff from '@lucide/svelte/icons/screen-share-off'
  import Settings2 from '@lucide/svelte/icons/settings-2'
  import Video from '@lucide/svelte/icons/video'
  import VideoOff from '@lucide/svelte/icons/video-off'
  import Volume2 from '@lucide/svelte/icons/volume-2'
  import X from '@lucide/svelte/icons/x'
  import { onDestroy, onMount } from 'svelte'
  import CallTile from './call-tile.svelte'
  import DevicePicker from './device-picker.svelte'
  import { gridLayout, stageOf } from './layout'

  /**
   * The call page's view of the live call (plan/video-calls.md §3). The call
   * itself lives above the page (ActiveCall, owned by the nucleus layout):
   * mounting this view opens it — joins, or just shows it when I am in it
   * already — and leaving the page keeps it running (the docked mini call
   * takes over). Only the hang-up button, closing the tab or the call ending
   * ends it. In another call already → it says so plainly and joins nothing.
   *
   * The stage uses the space: a shared screen big with people in a strip;
   * two people → the other fills the stage and I am a small self view;
   * otherwise a grid sized to the count and the stage's aspect, the active
   * speaker emphasised.
   */
  let {
    active,
    call,
    me,
    onleave,
    onopen,
  }: {
    active: ActiveCall
    call: CallDto
    me: string
    /** After hanging up, or "Back to calls". */
    onleave: () => void
    /** Go to the call I am in (from "already in a call"). */
    onopen: (callId: string) => void
  } = $props()

  const GAP = 8
  let stageW = $state(0)
  let stageH = $state(0)
  /** open() ran (in the browser): until then the page only says it is connecting. */
  let opened = $state(false)
  let devicesOpen = $state(false)

  const mine = $derived(active.call?.id === call.id)
  const busy = $derived(!mine && active.inCall)
  const s = $derived(active.state)
  const participants = $derived(active.participants)
  const stage = $derived(stageOf(participants, active.speaker))
  const others = $derived(participants.filter((p) => !p.isLocal))
  const grid = $derived(stage.mode === 'grid' ? gridLayout({ width: stageW, height: stageH, count: stage.tiles.length, gap: GAP }) : null)
  /** The focus strip sits at the side on a wide stage, under the shared screen on a narrow one. */
  const wide = $derived(stageW >= 640 && stageW > stageH * 1.2)
  const portrait = $derived(stageH > stageW)

  onMount(() => {
    active.open(call, me)
    opened = true
  })

  onDestroy(() => {
    if (active.call?.id === call.id) active.release()
  })

  async function hangUp() {
    await active.hangUp()
    onleave()
  }

  function toggleDevices() {
    devicesOpen = !devicesOpen
    if (devicesOpen) void active.refreshDevices()
  }

  const status = $derived(
    !opened
      ? 'Connecting…'
      : !mine
      ? ''
      : s.phase === 'connecting'
        ? 'Connecting…'
        : s.phase === 'reconnecting'
          ? 'Reconnecting…'
          : s.phase === 'connected'
            ? others.length === 0
              ? 'Waiting for others to join…'
              : `${participants.length} in the call`
            : s.phase === 'ended'
              ? 'Call ended'
              : 'Not connected',
  )

  const endedText = $derived.by(() => {
    switch (s.ended) {
      case 'hung_up':
        return 'You left the call.'
      case 'joined_elsewhere':
        return 'You joined this call from another tab or device.'
      case 'connection_lost':
        return 'The connection to the call was lost.'
      case 'call_over':
        return active.finalState === 'missed'
          ? 'Nobody answered.'
          : active.finalState === 'declined'
            ? 'The call was declined.'
            : 'The call has ended.'
      default:
        return ''
    }
  })
</script>

{#snippet control(label: string, pressed: boolean, testid: string, on: boolean, onclick: () => void)}
  <button
    type="button"
    class={[
      'grid size-12 shrink-0 place-items-center rounded-full transition-colors disabled:opacity-50',
      pressed ? 'bg-white text-neutral-900 hover:bg-white/90' : 'bg-white/15 text-white hover:bg-white/25',
    ]}
    aria-label={label}
    title={label}
    aria-pressed={pressed}
    disabled={s.phase !== 'connected'}
    data-testid={testid}
    data-on={on ? 'true' : 'false'}
    {onclick}
  >
    {#if testid === 'call-mic'}{#if on}<Mic class="size-5" />{:else}<MicOff class="size-5" />{/if}
    {:else if testid === 'call-camera'}{#if on}<Video class="size-5" />{:else}<VideoOff class="size-5" />{/if}
    {:else if on}<ScreenShareOff class="size-5" />{:else}<ScreenShare class="size-5" />{/if}
  </button>
{/snippet}

<div
  class="flex h-full min-h-0 w-full flex-1 flex-col bg-neutral-950 text-neutral-50"
  data-testid="call-view"
  data-phase={mine ? s.phase : 'none'}
  data-mode={mine ? stage.mode : 'none'}
>
  <header class="flex h-14 shrink-0 items-center gap-3 border-b border-white/10 px-4 sm:px-5">
    <div class="min-w-0 flex-1">
      <h1 class="truncate text-base font-semibold" data-testid="call-title">{call.title}</h1>
      <p class="truncate text-xs text-neutral-400" data-testid="call-status">{status}</p>
    </div>
  </header>

  {#if !opened}
    <div class="grid flex-1 place-items-center text-sm text-neutral-400" data-testid="call-connecting">Connecting…</div>
  {:else if !mine}
    <div class="grid flex-1 place-items-center p-6 text-center" data-testid="call-busy">
      <div class="max-w-sm">
        {#if busy && active.call}
          <p class="text-base font-semibold" role="alert">You're already in a call: {active.call.title}.</p>
          <p class="mt-2 text-sm text-neutral-400">Hang up that call first to join this one.</p>
          <div class="mt-5 flex flex-wrap justify-center gap-2">
            <button
              type="button"
              class="h-9 rounded-md bg-white px-4 text-sm font-semibold text-neutral-900 hover:bg-white/90"
              data-testid="call-busy-back"
              onclick={() => active.call && onopen(active.call.id)}>Back to your call</button
            >
            <button type="button" class="h-9 rounded-md border border-white/20 px-4 text-sm font-semibold hover:bg-white/10" data-testid="call-back" onclick={onleave}
              >Back to calls</button
            >
          </div>
        {:else}
          <p class="text-base font-semibold">Your other call is over.</p>
          <div class="mt-5 flex justify-center gap-2">
            <button
              type="button"
              class="h-9 rounded-md bg-white px-4 text-sm font-semibold text-neutral-900 hover:bg-white/90"
              data-testid="call-join"
              onclick={() => active.open(call, me)}>Join this call</button
            >
          </div>
        {/if}
      </div>
    </div>
  {:else if s.phase === 'error' && s.problem}
    <div class="grid flex-1 place-items-center p-6 text-center" data-testid="call-problem" data-kind={s.problem.kind}>
      <div class="max-w-sm">
        <p class="text-base font-semibold" role="alert">{s.problem.message}</p>
        {#if s.problem.kind === 'not_configured'}
          <p class="mt-2 text-sm text-neutral-400">Video calls need the company's call server. An owner or admin can turn it on for this server.</p>
        {/if}
        <div class="mt-5 flex justify-center gap-2">
          {#if s.problem.kind === 'failed'}
            <button
              type="button"
              class="h-9 rounded-md bg-white px-4 text-sm font-semibold text-neutral-900 hover:bg-white/90"
              data-testid="call-retry"
              onclick={() => active.rejoin()}>Try again</button
            >
          {/if}
          <button type="button" class="h-9 rounded-md border border-white/20 px-4 text-sm font-semibold hover:bg-white/10" data-testid="call-back" onclick={onleave}
            >Back to calls</button
          >
        </div>
      </div>
    </div>
  {:else if s.phase === 'ended'}
    <div class="grid flex-1 place-items-center p-6 text-center" data-testid="call-ended" data-reason={s.ended}>
      <div class="max-w-sm">
        <p class="text-base font-semibold">{endedText}</p>
        <div class="mt-5 flex justify-center gap-2">
          {#if s.ended === 'connection_lost' || s.ended === 'joined_elsewhere'}
            <button
              type="button"
              class="h-9 rounded-md bg-white px-4 text-sm font-semibold text-neutral-900 hover:bg-white/90"
              data-testid="call-rejoin"
              onclick={() => active.rejoin()}>Rejoin</button
            >
          {/if}
          <button type="button" class="h-9 rounded-md border border-white/20 px-4 text-sm font-semibold hover:bg-white/10" data-testid="call-back" onclick={onleave}
            >Back to calls</button
          >
        </div>
      </div>
    </div>
  {:else}
    <div class="relative flex min-h-0 flex-1 flex-col p-2 sm:p-3">
      {#if s.notices.length > 0 || active.audioBlocked}
        <div class="absolute inset-x-2 top-2 z-10 mx-auto flex max-w-2xl flex-col gap-2 sm:inset-x-3 sm:top-3">
          {#each s.notices as n (n.device)}
            <div
              class="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-neutral-900/95 p-3 text-sm"
              role="alert"
              data-testid="call-notice"
              data-device={n.device}
              data-failure={n.failure}
            >
              <p class="min-w-0 flex-1">{n.message}</p>
              <button type="button" class="text-neutral-400 hover:text-white" aria-label="Dismiss" onclick={() => active.dismissNotice(n.device)}
                ><X class="size-4" /></button
              >
            </div>
          {/each}
          {#if active.audioBlocked}
            <button
              type="button"
              class="flex items-center justify-center gap-2 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-neutral-900 hover:bg-white/90"
              data-testid="call-start-audio"
              onclick={() => active.startAudio()}><Volume2 class="size-4" aria-hidden="true" /> Your browser paused the sound. Click to hear the call.</button
            >
          {/if}
        </div>
      {/if}

      <div class="relative min-h-0 flex-1" bind:clientWidth={stageW} bind:clientHeight={stageH} data-testid="call-stage">
        {#if s.phase === 'connecting'}
          <div class="grid h-full place-items-center text-sm text-neutral-400" data-testid="call-connecting">Connecting…</div>
        {:else if stage.mode === 'grid' && grid}
          <div class="flex size-full flex-wrap content-center items-center justify-center" style="gap:{GAP}px" data-testid="call-grid" data-columns={grid.columns}>
            {#each stage.tiles as t (t.key)}
              <CallTile tile={t} emphasised={stage.tiles.length > 2 && t.identity === stage.speaker} style="width:{grid.tileWidth}px;height:{grid.tileHeight}px" />
            {/each}
          </div>
        {:else if stage.mode === 'pair'}
          <div class="relative size-full" data-testid="call-grid">
            <CallTile tile={stage.main} fit={portrait ? 'cover' : 'contain'} class="size-full" />
            <!-- The self view floats over the other person's corner. -->
            <div class="absolute right-2 bottom-2 z-[1] aspect-[3/4] w-24 sm:right-3 sm:bottom-3 sm:aspect-video sm:w-56">
              <CallTile tile={stage.self} size="small" class="size-full shadow-lg" />
            </div>
          </div>
        {:else if stage.mode === 'focus'}
          <div class={['flex size-full', wide ? 'flex-row' : 'flex-col']} style="gap:{GAP}px" data-testid="call-grid">
            <div class="min-h-0 min-w-0 flex-1">
              <CallTile tile={stage.main} fit="contain" class="size-full" />
            </div>
            <div
              class={['flex shrink-0', wide ? 'w-52 flex-col overflow-y-auto' : 'h-24 flex-row overflow-x-auto']}
              style="gap:{GAP}px"
              data-testid="call-strip"
            >
              {#each stage.strip as t (t.key)}
                <CallTile tile={t} size="small" emphasised={t.identity === stage.speaker && t.kind === 'camera'} class={['shrink-0', wide ? 'aspect-video w-full' : 'h-full aspect-video'].join(' ')} />
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  {#if mine && active.inCall}
    <div class="relative shrink-0">
      {#if devicesOpen}
        <div class="absolute inset-x-2 bottom-full z-20 mb-2 sm:inset-x-auto sm:right-1/2 sm:w-80 sm:translate-x-1/2">
          <DevicePicker {active} onclose={() => (devicesOpen = false)} />
        </div>
      {/if}
      <footer
        class="flex items-center justify-center gap-2 border-t border-white/10 px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:gap-3"
        data-testid="call-controls"
      >
        {@render control(s.mic ? 'Mute' : 'Unmute', !s.mic, 'call-mic', s.mic, () => active.turn('microphone', !s.mic))}
        {@render control(s.camera ? 'Turn camera off' : 'Turn camera on', !s.camera, 'call-camera', s.camera, () => active.turn('camera', !s.camera))}
        {#if active.canShareScreen}
          {@render control(s.screen ? 'Stop sharing' : 'Share screen', s.screen, 'call-screen', s.screen, () => active.turn('screen', !s.screen))}
        {/if}
        <button
          type="button"
          class={[
            'grid size-12 shrink-0 place-items-center rounded-full transition-colors disabled:opacity-50',
            devicesOpen ? 'bg-white text-neutral-900 hover:bg-white/90' : 'bg-white/15 text-white hover:bg-white/25',
          ]}
          aria-label="Devices"
          title="Microphone, speaker and camera"
          aria-expanded={devicesOpen}
          disabled={s.phase !== 'connected'}
          data-testid="call-devices-toggle"
          onclick={toggleDevices}><Settings2 class="size-5" /></button
        >
        <button
          type="button"
          class="grid h-12 w-16 shrink-0 place-items-center rounded-full bg-red-600 text-white hover:bg-red-700"
          aria-label="Hang up"
          title="Hang up"
          data-testid="call-hangup"
          onclick={hangUp}><PhoneOff class="size-5" /></button
        >
      </footer>
    </div>
  {/if}
</div>
