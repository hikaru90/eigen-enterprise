<script lang="ts">
  import type { ActiveCall, StartWith } from './active-call.svelte'
  import type { CallBrain } from './call-brain.svelte'
  import type { CallChat } from './call-chat.svelte'
  import type { CallTranscription } from './call-transcription.svelte'
  import type { BrainClient, CallDto, CallsClient } from './client'
  import Brain from '@lucide/svelte/icons/brain'
  import Captions from '@lucide/svelte/icons/captions'
  import CaptionsOff from '@lucide/svelte/icons/captions-off'
  import MessageSquare from '@lucide/svelte/icons/message-square'
  import Mic from '@lucide/svelte/icons/mic'
  import MicOff from '@lucide/svelte/icons/mic-off'
  import PhoneOff from '@lucide/svelte/icons/phone-off'
  import ScreenShare from '@lucide/svelte/icons/screen-share'
  import ScreenShareOff from '@lucide/svelte/icons/screen-share-off'
  import Settings2 from '@lucide/svelte/icons/settings-2'
  import UserPlus from '@lucide/svelte/icons/user-plus'
  import Video from '@lucide/svelte/icons/video'
  import VideoOff from '@lucide/svelte/icons/video-off'
  import Volume2 from '@lucide/svelte/icons/volume-2'
  import X from '@lucide/svelte/icons/x'
  import { onDestroy, onMount } from 'svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import BrainRecap from './brain-recap.svelte'
  import CallBrainPanel from './call-brain-panel.svelte'
  import CallChatPanel from './call-chat-panel.svelte'
  import CallTile from './call-tile.svelte'
  import DevicePicker from './device-picker.svelte'
  import { callClock } from './format'
  import { gridLayout, stageOf } from './layout'
  import MeetingGuests from './meeting-guests.svelte'

  /**
   * The call tab's view of the live call (plan/video-calls.md §3). The call
   * itself is the ActiveCall the call page owns: mounting this view opens it —
   * joins, or just shows it when I am in it already. Only the hang-up button,
   * closing the tab or the call ending ends it. In another call already → it
   * says so plainly and joins nothing.
   *
   * The stage uses the space: a shared screen big with people in a strip;
   * two people → the other fills the stage and I am a small self view;
   * otherwise a grid sized to the count and the stage's aspect, the active
   * speaker emphasised.
   *
   * The header shows how long the call has been going (from the server's
   * answer time: the same number for everyone, kept on a rejoin) and, with
   * `transcription`, that the call is transcribed and by whom; the controls
   * carry my own transcription switch.
   *
   * The Company Brain (modules/calls/brain.ts): everyone in the call — guests
   * too — sees "Company Brain listening" in the header while it is on. With
   * `brain` (people of the company) the controls open its panel: the switch,
   * "Ask the Brain", my private answers and what was shared. With
   * `brainRecap`, the ended screen offers whoever switched it on a recap.
   *
   * The chat (proposal bb05b451): with `chat`, the controls carry its toggle —
   * a badge counts lines from others while the panel is closed — and the panel
   * sits beside the stage (over it on a phone), one side panel at a time.
   * `chatDictation`: the chat line takes dictation (people of the company).
   */
  let {
    active,
    call,
    me,
    leaveLabel,
    onleave,
    onhungup,
    onopen,
    startWith = { microphone: true, camera: true },
    transcription = null,
    transcriptHref = null,
    brain = null,
    brainRecap = null,
    recapImportHref = null,
    chat = null,
    chatDictation = true,
    invite = null,
  }: {
    active: ActiveCall
    call: CallDto
    me: string
    /** The leave button's words once the call is over or never started ("Close", "Back to calls"). */
    leaveLabel: string
    /** The leave button. */
    onleave: () => void
    /** After the hang-up button left the call. */
    onhungup: () => void
    /** Go to the call I am in (from "already in a call"). */
    onopen: (callId: string) => void
    /** Devices to turn on once connected (a guest's choice on the preview). */
    startWith?: StartWith
    /** Call transcripts for this view (the indicator and my switch); null: this view shows none. */
    transcription?: CallTranscription | null
    /** Where the call's transcript is read after the call (people of the company); null: no link. */
    transcriptHref?: string | null
    /** The Company Brain, my side (members); null: no panel (a guest only sees the indicator). */
    brain?: CallBrain | null
    /** The recap after the call, offered to whoever switched the Brain on; null: no offer. */
    brainRecap?: Pick<BrainClient, 'brainRecap'> | null
    /** Where "Import into the brain" drafts the recap into the assistant chat (recap-import.ts); null: no offer. */
    recapImportHref?: string | null
    /** The call's chat (members and guests); null: this view has none. */
    chat?: CallChat | null
    /** The chat line takes dictation (false for a guest: no account to transcribe for). */
    chatDictation?: boolean
    /**
     * "Invite people from outside": the host of a call of our own invites guests
     * by email from inside the live call (calls.invite_guests); null: not the host
     * of such a call, no button.
     */
    invite?: Pick<CallsClient, 'inviteGuests' | 'revokeGuest'> | null
  } = $props()

  let brainOpen = $state(false)

  function toggleBrainPanel() {
    brainOpen = !brainOpen
    if (brainOpen) {
      chat?.hide()
      void brain?.load()
    }
  }

  function toggleChat() {
    if (!chat) return
    if (!chat.open) brainOpen = false
    chat.toggle()
  }

  const unread = $derived(chat ? chat.unread : 0)

  const GAP = 8
  let stageW = $state(0)
  let stageH = $state(0)
  /** open() ran (in the browser): until then the page only says it is connecting. */
  let opened = $state(false)
  let devicesOpen = $state(false)
  let inviteOpen = $state(false)

  const mine = $derived(active.call?.id === call.id)
  const busy = $derived(!mine && active.inCall)
  const s = $derived(active.state)
  const participants = $derived(active.participants)
  const stage = $derived(stageOf(participants, active.speaker))
  const others = $derived(participants.filter((p) => !p.isLocal))
  const grid = $derived(
    stage.mode === 'grid'
      ? gridLayout({ width: stageW, height: stageH, count: stage.tiles.length, gap: GAP })
      : null,
  )
  /** The focus strip sits at the side on a wide stage, under the shared screen on a narrow one. */
  const wide = $derived(stageW >= 640 && stageW > stageH * 1.2)
  const portrait = $derived(stageH > stageW)

  /** The clock's "now", ticking each second from mount (an interval, not an effect). */
  let nowMs = $state(Date.now())
  let tick: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    active.open(call, me, startWith)
    opened = true
    tick = setInterval(() => (nowMs = Date.now()), 1000)
  })

  onDestroy(() => {
    clearInterval(tick)
    if (active.call?.id === call.id) active.release()
  })

  /** The call as the server last told us (the feed / refreshes update it): its answer time starts the clock. */
  const answeredAt = $derived(mine ? (active.call?.answeredAt ?? null) : null)
  const clock = $derived(
    answeredAt && (s.phase === 'connected' || s.phase === 'reconnecting')
      ? callClock(answeredAt, nowMs)
      : null,
  )
  const transcribed = $derived(
    transcription && mine && active.inCall ? transcription.transcribed : [],
  )
  /** The indicator everyone in the call sees (my own switch shows at once). */
  const brainListening = $derived(
    mine && active.inCall && (brain ? brain.listening : active.call?.brain.listening === true),
  )
  const brainBy = $derived(mine ? (active.call?.brain.byName ?? null) : null)
  /** I am out of the call and switched the Brain on in it: offer the recap (the server says so if the call still goes on). */
  const recapOffered = $derived(
    brainRecap !== null &&
      mine &&
      (s.ended === 'call_over' || s.ended === 'hung_up') &&
      (active.call?.brain.turnedOnBy.includes(me) ?? false),
  )

  async function hangUp() {
    await active.hangUp()
    onhungup()
  }

  function toggleDevices() {
    devicesOpen = !devicesOpen
    inviteOpen = false
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

{#snippet control(
  label: string,
  pressed: boolean,
  testid: string,
  on: boolean,
  onclick: () => void,
)}
  <button
    type="button"
    class={[
      'grid size-11 shrink-0 place-items-center rounded-full transition-colors disabled:opacity-50 sm:size-12',
      pressed
        ? 'bg-white text-neutral-900 hover:bg-white/90'
        : 'bg-white/15 text-white hover:bg-white/25',
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
    {:else if testid === 'call-camera'}{#if on}<Video class="size-5" />{:else}<VideoOff
          class="size-5"
        />{/if}
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
    {#if transcribed.length > 0}
      <span
        class="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-xs font-medium"
        role="status"
        title={`Transcribed: ${transcribed.join(', ')}`}
        data-testid="call-transcript-indicator"
        ><span class="size-1.5 rounded-full bg-red-500" aria-hidden="true"></span>Transcript on</span
      >
    {/if}
    {#if brainListening}
      <span
        class="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-xs font-medium"
        role="status"
        title={brainBy
          ? `${brainBy} switched the Company Brain on. It only listens and answers only when someone asks it.`
          : 'The Company Brain is listening. It only listens and answers only when someone asks it.'}
        data-testid="call-brain-indicator"
        ><span class="size-1.5 rounded-full bg-amber-300" aria-hidden="true"></span>Company Brain
        listening</span
      >
    {/if}
    {#if clock}
      <span
        class="shrink-0 font-mono text-sm tabular-nums text-neutral-300"
        aria-label={`Call time ${clock}`}
        data-testid="call-clock">{clock}</span
      >
    {/if}
  </header>

  {#if !opened}
    <div
      class="grid flex-1 place-items-center text-sm text-neutral-400"
      data-testid="call-connecting"
    >
      Connecting…
    </div>
  {:else if !mine}
    <div class="grid flex-1 place-items-center p-6 text-center" data-testid="call-busy">
      <div class="max-w-sm">
        {#if busy && active.call}
          <p class="text-base font-semibold" role="alert">
            You're already in a call: {active.call.title}.
          </p>
          <p class="mt-2 text-sm text-neutral-400">Hang up that call first to join this one.</p>
          <div class="mt-5 flex flex-wrap justify-center gap-2">
            <button
              type="button"
              class="h-9 rounded-md bg-white px-4 text-sm font-semibold text-neutral-900 hover:bg-white/90"
              data-testid="call-busy-back"
              onclick={() => active.call && onopen(active.call.id)}>Back to your call</button
            >
            <button
              type="button"
              class="h-9 rounded-md border border-white/20 px-4 text-sm font-semibold hover:bg-white/10"
              data-testid="call-back"
              onclick={onleave}>{leaveLabel}</button
            >
          </div>
        {:else}
          <p class="text-base font-semibold">Your other call is over.</p>
          <div class="mt-5 flex justify-center gap-2">
            <button
              type="button"
              class="h-9 rounded-md bg-white px-4 text-sm font-semibold text-neutral-900 hover:bg-white/90"
              data-testid="call-join"
              onclick={() => active.open(call, me, startWith)}>Join this call</button
            >
          </div>
        {/if}
      </div>
    </div>
  {:else if s.phase === 'error' && s.problem}
    <div
      class="grid flex-1 place-items-center p-6 text-center"
      data-testid="call-problem"
      data-kind={s.problem.kind}
    >
      <div class="max-w-sm">
        <ErrorNotice
          class="items-center text-base font-semibold"
          error={s.problem.message}
          agent={s.problem.agent}
          attempted="Joining a video call"
        />
        {#if s.problem.kind === 'not_configured'}
          <p class="mt-2 text-sm text-neutral-400">
            Video calls need the company's call server. An owner or admin can turn it on for this
            server.
          </p>
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
          <button
            type="button"
            class="h-9 rounded-md border border-white/20 px-4 text-sm font-semibold hover:bg-white/10"
            data-testid="call-back"
            onclick={onleave}>{leaveLabel}</button
          >
        </div>
      </div>
    </div>
  {:else if s.phase === 'ended'}
    <div
      class="grid flex-1 place-items-center p-6 text-center"
      data-testid="call-ended"
      data-reason={s.ended}
    >
      <div class="max-w-sm">
        <p class="text-base font-semibold">{endedText}</p>
        {#if recapOffered && brainRecap && active.call}
          <div class="mt-5">
            <BrainRecap
              callId={active.call.id}
              client={brainRecap}
              tone="dark"
              importHref={recapImportHref}
            />
          </div>
        {/if}
        <div class="mt-5 flex flex-wrap justify-center gap-2">
          {#if transcriptHref && (s.ended === 'hung_up' || s.ended === 'call_over')}
            <!-- eslint-disable svelte/no-navigation-without-resolve -- the page passes it through resolve() -->
            <a
              href={transcriptHref}
              class="inline-flex h-9 items-center rounded-md border border-white/20 px-4 text-sm font-semibold hover:bg-white/10"
              data-testid="call-transcript-link">Transcript</a
            >
            <!-- eslint-enable svelte/no-navigation-without-resolve -->
          {/if}
          {#if s.ended === 'connection_lost' || s.ended === 'joined_elsewhere'}
            <button
              type="button"
              class="h-9 rounded-md bg-white px-4 text-sm font-semibold text-neutral-900 hover:bg-white/90"
              data-testid="call-rejoin"
              onclick={() => active.rejoin()}>Rejoin</button
            >
          {/if}
          <button
            type="button"
            class="h-9 rounded-md border border-white/20 px-4 text-sm font-semibold hover:bg-white/10"
            data-testid="call-back"
            onclick={onleave}>{leaveLabel}</button
          >
        </div>
      </div>
    </div>
  {:else}
    <div class="relative flex min-h-0 flex-1">
      <div class="relative flex min-h-0 min-w-0 flex-1 flex-col p-2 sm:p-3">
        {#if s.notices.length > 0 || active.audioBlocked || transcription?.problem}
          <div
            class="absolute inset-x-2 top-2 z-10 mx-auto flex max-w-2xl flex-col gap-2 sm:inset-x-3 sm:top-3"
          >
            {#each s.notices as n (n.device)}
              <div
                class="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-neutral-900/95 p-3 text-sm"
                role="alert"
                data-testid="call-notice"
                data-device={n.device}
                data-failure={n.failure}
              >
                <p class="min-w-0 flex-1">{n.message}</p>
                <button
                  type="button"
                  class="text-neutral-400 hover:text-white"
                  aria-label="Dismiss"
                  onclick={() => active.dismissNotice(n.device)}><X class="size-4" /></button
                >
              </div>
            {/each}
            {#if transcription?.problem}
              <div
                class="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-neutral-900/95 p-3 text-sm"
                data-testid="call-transcript-problem"
              >
                <ErrorNotice
                  class="min-w-0 flex-1"
                  error={transcription.problem.error}
                  agent={transcription.problem.agent}
                  attempted="Transcribing my microphone in a call"
                />
                {#if !transcription.unavailable}
                  <button
                    type="button"
                    class="text-neutral-400 hover:text-white"
                    aria-label="Dismiss"
                    onclick={() => transcription?.dismissProblem()}><X class="size-4" /></button
                  >
                {/if}
              </div>
            {/if}
            {#if active.audioBlocked}
              <button
                type="button"
                class="flex items-center justify-center gap-2 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-neutral-900 hover:bg-white/90"
                data-testid="call-start-audio"
                onclick={() => active.startAudio()}
                ><Volume2 class="size-4" aria-hidden="true" /> Your browser paused the sound. Click to
                hear the call.</button
              >
            {/if}
          </div>
        {/if}

        <div
          class="relative min-h-0 flex-1"
          bind:clientWidth={stageW}
          bind:clientHeight={stageH}
          data-testid="call-stage"
        >
          {#if s.phase === 'connecting'}
            <div
              class="grid h-full place-items-center text-sm text-neutral-400"
              data-testid="call-connecting"
            >
              Connecting…
            </div>
          {:else if stage.mode === 'grid' && grid}
            <div
              class="flex size-full flex-wrap content-center items-center justify-center"
              style="gap:{GAP}px"
              data-testid="call-grid"
              data-columns={grid.columns}
            >
              {#each stage.tiles as t (t.key)}
                <CallTile
                  tile={t}
                  emphasised={stage.tiles.length > 2 && t.identity === stage.speaker}
                  style="width:{grid.tileWidth}px;height:{grid.tileHeight}px"
                />
              {/each}
            </div>
          {:else if stage.mode === 'pair'}
            <div class="relative size-full" data-testid="call-grid">
              <CallTile tile={stage.main} fit={portrait ? 'cover' : 'contain'} class="size-full" />
              <!-- The self view floats over the other person's corner. -->
              <div
                class="absolute right-2 bottom-2 z-[1] aspect-[3/4] w-24 sm:right-3 sm:bottom-3 sm:aspect-video sm:w-56"
              >
                <CallTile tile={stage.self} size="small" class="size-full shadow-lg" />
              </div>
            </div>
          {:else if stage.mode === 'focus'}
            <div
              class={['flex size-full', wide ? 'flex-row' : 'flex-col']}
              style="gap:{GAP}px"
              data-testid="call-grid"
            >
              <div class="min-h-0 min-w-0 flex-1">
                <CallTile tile={stage.main} fit="contain" class="size-full" />
              </div>
              <div
                class={[
                  'flex shrink-0',
                  wide ? 'w-52 flex-col overflow-y-auto' : 'h-24 flex-row overflow-x-auto',
                ]}
                style="gap:{GAP}px"
                data-testid="call-strip"
              >
                {#each stage.strip as t (t.key)}
                  <CallTile
                    tile={t}
                    size="small"
                    emphasised={t.identity === stage.speaker && t.kind === 'camera'}
                    class={['shrink-0', wide ? 'aspect-video w-full' : 'h-full aspect-video'].join(
                      ' ',
                    )}
                  />
                {/each}
              </div>
            </div>
          {/if}
        </div>
      </div>
      {#if brain && brainOpen && active.inCall}
        <!-- Beside the stage on a wide screen; over it on a phone. -->
        <div
          class="absolute inset-0 z-20 sm:static sm:z-auto sm:w-80 sm:shrink-0 sm:border-l sm:border-white/10"
        >
          <CallBrainPanel {brain} onclose={() => (brainOpen = false)} />
        </div>
      {:else if chat && chat.open && active.inCall}
        <div
          class="absolute inset-0 z-20 sm:static sm:z-auto sm:w-80 sm:shrink-0 sm:border-l sm:border-white/10"
        >
          <CallChatPanel {chat} dictation={chatDictation} onclose={() => chat?.hide()} />
        </div>
      {/if}
    </div>
  {/if}

  {#if mine && active.inCall}
    <div class="relative shrink-0">
      {#if inviteOpen && invite}
        <div
          class="absolute inset-x-2 bottom-full z-20 mb-2 sm:inset-x-auto sm:right-1/2 sm:w-96 sm:translate-x-1/2"
          data-testid="call-invite-panel"
        >
          <div
            class="w-full rounded-xl border border-white/10 bg-neutral-900 p-3 text-sm text-neutral-50 shadow-xl"
          >
            <div class="mb-2 flex items-center justify-between">
              <p class="text-xs font-semibold tracking-wide text-neutral-400 uppercase">
                Invite people from outside
              </p>
              <button
                type="button"
                class="grid size-7 place-items-center rounded-md text-neutral-400 hover:bg-white/10 hover:text-white"
                aria-label="Close invitations"
                onclick={() => (inviteOpen = false)}><X class="size-4" /></button
              >
            </div>
            <MeetingGuests
              call={active.call ?? call}
              client={invite}
              onchange={(c) => active.update(c)}
            />
          </div>
        </div>
      {:else if devicesOpen}
        <div
          class="absolute inset-x-2 bottom-full z-20 mb-2 sm:inset-x-auto sm:right-1/2 sm:w-80 sm:translate-x-1/2"
        >
          <DevicePicker {active} onclose={() => (devicesOpen = false)} />
        </div>
      {/if}
      <footer
        class="flex flex-wrap items-center justify-center gap-1.5 border-t border-white/10 px-2 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:gap-3 sm:px-3"
        data-testid="call-controls"
      >
        {@render control(s.mic ? 'Mute' : 'Unmute', !s.mic, 'call-mic', s.mic, () =>
          active.turn('microphone', !s.mic),
        )}
        {@render control(
          s.camera ? 'Turn camera off' : 'Turn camera on',
          !s.camera,
          'call-camera',
          s.camera,
          () => active.turn('camera', !s.camera),
        )}
        {#if active.canShareScreen}
          {@render control(
            s.screen ? 'Stop sharing' : 'Share screen',
            s.screen,
            'call-screen',
            s.screen,
            () => active.turn('screen', !s.screen),
          )}
        {/if}
        {#if transcription && !transcription.unavailable}
          <button
            type="button"
            class={[
              'grid size-11 shrink-0 place-items-center rounded-full transition-colors disabled:opacity-50 sm:size-12',
              transcription.on
                ? 'bg-white/15 text-white hover:bg-white/25'
                : 'bg-white text-neutral-900 hover:bg-white/90',
            ]}
            aria-label={transcription.on
              ? 'Stop transcribing my microphone'
              : 'Transcribe my microphone'}
            title={transcription.on
              ? 'Your microphone is transcribed — click to stop'
              : 'Your microphone is not transcribed — click to turn it on'}
            aria-pressed={transcription.on}
            disabled={s.phase !== 'connected'}
            data-testid="call-transcribe"
            onclick={() => transcription?.toggle()}
            >{#if transcription.on}<Captions class="size-5" />{:else}<CaptionsOff
                class="size-5"
              />{/if}</button
          >
        {/if}
        {#if brain}
          <button
            type="button"
            class={[
              'relative grid size-11 shrink-0 place-items-center rounded-full transition-colors sm:size-12',
              brainOpen
                ? 'bg-white text-neutral-900 hover:bg-white/90'
                : 'bg-white/15 text-white hover:bg-white/25',
            ]}
            aria-label="Company Brain"
            title={brain.listening
              ? 'Company Brain: listening — ask it, or switch it off'
              : 'Company Brain: off — bring it into this call'}
            aria-expanded={brainOpen}
            data-testid="call-brain-button"
            onclick={toggleBrainPanel}
            ><Brain class="size-5" />{#if brain.listening}<span
                class="absolute top-2 right-2 size-2 rounded-full bg-amber-300"
                aria-hidden="true"
              ></span>{/if}</button
          >
        {/if}
        {#if chat}
          <button
            type="button"
            class={[
              'relative grid size-11 shrink-0 place-items-center rounded-full transition-colors sm:size-12',
              chat.open
                ? 'bg-white text-neutral-900 hover:bg-white/90'
                : 'bg-white/15 text-white hover:bg-white/25',
            ]}
            aria-label={unread > 0 ? `Chat, ${unread} unread` : 'Chat'}
            title={unread > 0 ? `Chat: ${unread} new` : 'Chat with everyone in the call'}
            aria-expanded={chat.open}
            data-testid="call-chat-button"
            onclick={toggleChat}
            ><MessageSquare class="size-5" />{#if unread > 0}<span
                class="absolute -top-1 -right-1 grid h-5 min-w-5 place-items-center rounded-full bg-red-600 px-1 text-xs leading-none font-semibold text-white tabular-nums"
                aria-hidden="true"
                data-testid="call-chat-unread">{unread > 99 ? '99+' : unread}</span
              >{/if}</button
          >
        {/if}
        {#if invite}
          <button
            type="button"
            class={[
              'grid size-11 shrink-0 place-items-center rounded-full transition-colors sm:size-12',
              inviteOpen
                ? 'bg-white text-neutral-900 hover:bg-white/90'
                : 'bg-white/15 text-white hover:bg-white/25',
            ]}
            aria-label="Invite people from outside"
            title="Invite people from outside the company by email"
            aria-expanded={inviteOpen}
            data-testid="call-invite-toggle"
            onclick={() => ((inviteOpen = !inviteOpen), (devicesOpen = false))}
            ><UserPlus class="size-5" /></button
          >
        {/if}
        <button
          type="button"
          class={[
            'grid size-11 shrink-0 place-items-center rounded-full transition-colors disabled:opacity-50 sm:size-12',
            devicesOpen
              ? 'bg-white text-neutral-900 hover:bg-white/90'
              : 'bg-white/15 text-white hover:bg-white/25',
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
          class="grid h-11 w-14 shrink-0 place-items-center rounded-full bg-red-600 text-white hover:bg-red-700 sm:h-12 sm:w-16"
          aria-label="Hang up"
          title="Hang up"
          data-testid="call-hangup"
          onclick={hangUp}><PhoneOff class="size-5" /></button
        >
      </footer>
    </div>
  {/if}
</div>
