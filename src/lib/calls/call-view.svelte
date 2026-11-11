<script lang="ts">
  import Mic from '@lucide/svelte/icons/mic'
  import MicOff from '@lucide/svelte/icons/mic-off'
  import PhoneOff from '@lucide/svelte/icons/phone-off'
  import ScreenShare from '@lucide/svelte/icons/screen-share'
  import ScreenShareOff from '@lucide/svelte/icons/screen-share-off'
  import Video from '@lucide/svelte/icons/video'
  import VideoOff from '@lucide/svelte/icons/video-off'
  import Volume2 from '@lucide/svelte/icons/volume-2'
  import X from '@lucide/svelte/icons/x'
  import { onDestroy, onMount } from 'svelte'
  import UserAvatar from '$lib/components/user-avatar.svelte'
  import { callReducer, initialCallState, tilesOf, type CallEvent, type CallParticipant, type Device } from './call-state'
  import { problemOf, type CallDto, type CallsClient } from './client'
  import { MediaError, type CallRoom, type RoomSignal } from './room'

  /**
   * The call (plan/video-calls.md §3): joins on mount (accept if I have not,
   * then a room token, then the room), shows everyone in a grid, and offers
   * mute, camera off, screen share and hang up. Leaving — hang up, navigating
   * away, closing the tab — leaves the room and tells the server (/hangup).
   * Media goes through the injected CallRoom (LiveKit in the app, a fake in
   * component tests).
   */
  let {
    call,
    me,
    client,
    createRoom,
    onleave,
  }: {
    call: CallDto
    me: string
    client: Pick<CallsClient, 'accept' | 'token' | 'hangup' | 'get'>
    createRoom: () => CallRoom
    /** After hanging up, or "Back to calls". */
    onleave: () => void
  } = $props()

  let s = $state(initialCallState)
  let participants = $state<CallParticipant[]>([])
  let audioBlocked = $state(false)
  let canShareScreen = $state(false)
  /** The call as the server ended it (shown after LiveKit closed the room). */
  let finalState = $state<CallDto['state'] | null>(null)

  let room: CallRoom | null = null
  let unsubscribe = () => {}
  /** /hangup was sent (by the button or on leaving): never twice. */
  let hungUp = false

  const tiles = $derived(tilesOf(participants))
  const inCall = $derived(s.phase === 'connecting' || s.phase === 'connected' || s.phase === 'reconnecting')
  const others = $derived(participants.filter((p) => !p.isLocal))
  const columns = $derived(tiles.length <= 1 ? '' : tiles.length <= 4 ? 'sm:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-3')

  const dispatch = (e: CallEvent) => (s = callReducer(s, e))
  const refresh = () => (participants = room ? room.participants() : [])

  function onSignal(sig: RoomSignal) {
    switch (sig.type) {
      case 'participants':
        return refresh()
      case 'reconnecting':
      case 'reconnected':
        return dispatch({ type: sig.type })
      case 'media':
        return dispatch({ type: 'media', device: sig.device, on: sig.on })
      case 'audio':
        audioBlocked = sig.blocked
        return
      case 'disconnected':
        dispatch({ type: 'disconnected', reason: sig.reason })
        participants = []
        audioBlocked = false
        if (sig.reason === 'call_over') {
          client
            .get(call.id)
            .then((c) => (finalState = c.state))
            .catch((err: unknown) => console.error('[calls] loading the ended call failed', err))
        }
    }
  }

  async function turn(device: Device, on: boolean) {
    if (!room) return
    try {
      await room.setDevice(device, on)
      dispatch({ type: 'media', device, on })
    } catch (err) {
      if (err instanceof MediaError) dispatch({ type: 'media_failed', device, failure: err.failure, detail: err.message })
      else dispatch({ type: 'media_failed', device, failure: 'other', detail: err instanceof Error ? err.message : String(err) })
    }
  }

  async function join() {
    hungUp = false
    finalState = null
    try {
      const mine = call.participants.find((p) => p.userId === me)
      if (!mine || mine.response !== 'accepted') await client.accept(call.id)
      const t = await client.token(call.id)
      const r = createRoom()
      room = r
      unsubscribe = r.on(onSignal)
      try {
        await r.connect(t.url, t.token)
      } catch (err) {
        throw new Error(`could not connect to the call server (${err instanceof Error ? err.message : String(err)})`, { cause: err })
      }
      dispatch({ type: 'connected' })
      refresh()
      await turn('microphone', true)
      await turn('camera', true)
    } catch (err) {
      unsubscribe()
      room = null
      dispatch({ type: 'failed', problem: problemOf(err) })
    }
  }

  function rejoin() {
    unsubscribe()
    room = null
    dispatch({ type: 'retry' })
    void join()
  }

  /** Leave the room and tell the server — once. */
  function leave(keepalive: boolean): Promise<unknown> {
    const r = room
    room = null
    const disconnecting = r ? r.disconnect().catch((err: unknown) => console.error('[calls] leaving the room failed', err)) : Promise.resolve()
    if (hungUp) return disconnecting
    hungUp = true
    const told = client.hangup(call.id, { keepalive }).catch((err: unknown) => console.error('[calls] hang up failed', err))
    return Promise.all([disconnecting, told])
  }

  async function hangUp() {
    await leave(false)
    onleave()
  }

  const onPageHide = () => void leave(true)

  onMount(() => {
    canShareScreen = typeof navigator.mediaDevices?.getDisplayMedia === 'function'
    window.addEventListener('pagehide', onPageHide)
    void join()
  })

  onDestroy(() => {
    if (typeof window === 'undefined') return
    window.removeEventListener('pagehide', onPageHide)
    unsubscribe()
    void leave(true)
  })

  /** Shows a MediaStream in a <video> (always muted: sound plays through the room's audio elements). */
  function mediaStream(node: HTMLVideoElement, stream: MediaStream) {
    node.srcObject = stream
    return {
      update(next: MediaStream) {
        if (node.srcObject !== next) node.srcObject = next
      },
      destroy() {
        node.srcObject = null
      },
    }
  }

  const status = $derived(
    s.phase === 'connecting'
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
        return finalState === 'missed' ? 'Nobody answered.' : finalState === 'declined' ? 'The call was declined.' : 'The call has ended.'
      default:
        return ''
    }
  })
</script>

{#snippet control(label: string, pressed: boolean, testid: string, on: boolean, onclick: () => void)}
  <button
    type="button"
    class={[
      'grid size-12 place-items-center rounded-full transition-colors disabled:opacity-50',
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

<div class="flex h-full min-h-0 w-full flex-1 flex-col bg-neutral-950 text-neutral-50" data-testid="call-view" data-phase={s.phase}>
  <header class="flex h-14 shrink-0 items-center gap-3 border-b border-white/10 px-4 sm:px-5">
    <div class="min-w-0 flex-1">
      <h1 class="truncate text-base font-semibold" data-testid="call-title">{call.title}</h1>
      <p class="truncate text-xs text-neutral-400" data-testid="call-status">{status}</p>
    </div>
  </header>

  {#if s.phase === 'error' && s.problem}
    <div class="grid flex-1 place-items-center p-6 text-center" data-testid="call-problem" data-kind={s.problem.kind}>
      <div class="max-w-sm">
        <p class="text-base font-semibold" role="alert">{s.problem.message}</p>
        {#if s.problem.kind === 'not_configured'}
          <p class="mt-2 text-sm text-neutral-400">Video calls need the company's call server. An owner or admin can turn it on for this server.</p>
        {/if}
        <div class="mt-5 flex justify-center gap-2">
          {#if s.problem.kind === 'failed'}
            <button type="button" class="h-9 rounded-md bg-white px-4 text-sm font-semibold text-neutral-900 hover:bg-white/90" data-testid="call-retry" onclick={rejoin}
              >Try again</button
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
            <button type="button" class="h-9 rounded-md bg-white px-4 text-sm font-semibold text-neutral-900 hover:bg-white/90" data-testid="call-rejoin" onclick={rejoin}
              >Rejoin</button
            >
          {/if}
          <button type="button" class="h-9 rounded-md border border-white/20 px-4 text-sm font-semibold hover:bg-white/10" data-testid="call-back" onclick={onleave}
            >Back to calls</button
          >
        </div>
      </div>
    </div>
  {:else}
    <div class="relative min-h-0 flex-1 overflow-y-auto p-2 sm:p-4">
      {#if s.notices.length > 0 || audioBlocked}
        <div class="mx-auto mb-2 flex max-w-2xl flex-col gap-2">
          {#each s.notices as n (n.device)}
            <div class="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-sm" role="alert" data-testid="call-notice" data-device={n.device} data-failure={n.failure}>
              <p class="min-w-0 flex-1">{n.message}</p>
              <button type="button" class="text-neutral-400 hover:text-white" aria-label="Dismiss" onclick={() => dispatch({ type: 'dismiss_notice', device: n.device })}
                ><X class="size-4" /></button
              >
            </div>
          {/each}
          {#if audioBlocked}
            <button
              type="button"
              class="flex items-center justify-center gap-2 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-neutral-900 hover:bg-white/90"
              data-testid="call-start-audio"
              onclick={() => room?.startAudio().catch((err: unknown) => console.error('[calls] starting audio failed', err))}
              ><Volume2 class="size-4" aria-hidden="true" /> Your browser paused the sound. Click to hear the call.</button
            >
          {/if}
        </div>
      {/if}
      {#if s.phase === 'connecting'}
        <div class="grid h-full place-items-center text-sm text-neutral-400" data-testid="call-connecting">Connecting…</div>
      {:else}
        <div class={['mx-auto grid max-w-6xl grid-cols-1 gap-2 sm:gap-3', columns]} data-testid="call-grid">
          {#each tiles as t (t.key)}
            <div
              class={[
                'relative aspect-video overflow-hidden rounded-xl bg-neutral-900',
                t.speaking ? 'ring-2 ring-emerald-500' : 'ring-1 ring-white/10',
              ]}
              data-testid="call-tile"
              data-identity={t.identity}
              data-kind={t.kind}
              data-local={t.isLocal ? 'true' : 'false'}
              data-muted={t.micOn ? 'false' : 'true'}
              data-video={t.stream ? 'true' : 'false'}
            >
              {#if t.stream}
                <video
                  use:mediaStream={t.stream}
                  autoplay
                  playsinline
                  muted
                  class={['size-full', t.kind === 'screen' ? 'object-contain' : 'object-cover', t.isLocal && t.kind === 'camera' ? '-scale-x-100' : '']}
                  data-testid="call-video"
                ></video>
              {:else}
                <div class="grid size-full place-items-center">
                  <UserAvatar name={t.name} size="xl" round />
                </div>
              {/if}
              <div class="absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-md bg-black/60 px-2 py-1 text-xs font-medium">
                {#if t.kind === 'camera' && !t.micOn}<MicOff class="size-3.5 shrink-0 text-red-400" aria-label="Muted" data-testid="call-muted" />{/if}
                {#if t.kind === 'screen'}<ScreenShare class="size-3.5 shrink-0" aria-hidden="true" />{/if}
                <span class="truncate" data-testid="call-tile-name"
                  >{t.name}{t.isLocal ? ' (you)' : ''}{t.kind === 'screen' ? ' · screen' : ''}</span
                >
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if inCall}
    <footer class="flex shrink-0 items-center justify-center gap-3 border-t border-white/10 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" data-testid="call-controls">
      {@render control(s.mic ? 'Mute' : 'Unmute', !s.mic, 'call-mic', s.mic, () => turn('microphone', !s.mic))}
      {@render control(s.camera ? 'Turn camera off' : 'Turn camera on', !s.camera, 'call-camera', s.camera, () => turn('camera', !s.camera))}
      {#if canShareScreen}
        {@render control(s.screen ? 'Stop sharing' : 'Share screen', s.screen, 'call-screen', s.screen, () => turn('screen', !s.screen))}
      {/if}
      <button
        type="button"
        class="grid h-12 w-16 place-items-center rounded-full bg-red-600 text-white hover:bg-red-700"
        aria-label="Hang up"
        title="Hang up"
        data-testid="call-hangup"
        onclick={hangUp}><PhoneOff class="size-5" /></button
      >
    </footer>
  {/if}
</div>
