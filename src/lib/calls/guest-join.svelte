<script lang="ts">
  import type { GuestPageView } from '../../../modules/calls/service'
  import type { ActiveCall } from './active-call.svelte'
  import type { CallChat } from './call-chat.svelte'
  import type { CallTranscription } from './call-transcription.svelte'
  import type { CallDto } from './client'
  import Mic from '@lucide/svelte/icons/mic'
  import MicOff from '@lucide/svelte/icons/mic-off'
  import Video from '@lucide/svelte/icons/video'
  import VideoOff from '@lucide/svelte/icons/video-off'
  import { onDestroy } from 'svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import PublicFrame from '$lib/components/page/public-frame.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import CallView from './call-view.svelte'

  /**
   * The guest's side of a meeting (proposal 844bab56), on the public
   * /join/[token] page: no account, no install. The link's state first —
   * not found, too early, expired, over, withdrawn: a plain page, nothing to
   * join. Inside its window: your name → camera and microphone preview (turn
   * either off) → join. In the call the guest has the same call view as
   * everyone, labelled "Guest" for the others.
   *
   * Call transcripts: the preview says the call is transcribed and that the
   * guest can turn theirs off in the call (on by default, like everyone's).
   * A guest has no call feed, so the call's view is refreshed every
   * REFRESH_MS while in the call (its clock, who is transcribed).
   *
   * The call's chat (proposal bb05b451): with `makeChat`, the guest writes and
   * reads it as their guest name. No feed here either: while in the call the
   * chat is read on from its cursor every CHAT_REFRESH_MS (a small GET; a
   * chat needs to feel quicker than the call view's refresh).
   */
  let {
    view,
    call,
    makeActive,
    makeTranscription,
    getMedia,
    makeChat = null,
  }: {
    /** null: the link is not known. */
    view: GuestPageView | null
    call: CallDto | null
    /** The live call for this guest (LiveKit in the app, a fake in specs); `name` is read at join time. */
    makeActive: (name: () => string) => ActiveCall
    /** The transcription of the guest's own microphone in this call (`me` = their identity). */
    makeTranscription: (active: ActiveCall, me: string) => CallTranscription
    getMedia: (c: MediaStreamConstraints) => Promise<MediaStream>
    /** The call's chat for this guest (`me` = their identity); null: no chat on this page. */
    makeChat?: ((me: string, callId: string) => CallChat) | null
  } = $props()

  let step = $state<'name' | 'preview' | 'call'>('name')
  // The name the guest gave last time starts the field, once.
  // svelte-ignore state_referenced_locally
  let name = $state(view?.name ?? '')
  let error = $state<string | null>(null)
  let preview = $state<MediaStream | null>(null)
  let mediaProblem = $state<string | null>(null)
  let micOn = $state(true)
  let camOn = $state(true)
  let active = $state<ActiveCall | null>(null)
  let transcription = $state<CallTranscription | null>(null)
  let chat = $state<CallChat | null>(null)
  const REFRESH_MS = 10_000
  const CHAT_REFRESH_MS = 3_000
  let refresher: ReturnType<typeof setInterval> | undefined
  let chatRefresher: ReturnType<typeof setInterval> | undefined

  const dayFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' })
  const timeFmt = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' })
  const company = $derived(view?.companyName ? ` (${view.companyName})` : '')

  const headline = $derived.by(() => {
    if (!view) return 'This link doesn’t work'
    switch (view.status) {
      case 'too_early':
        return 'This call hasn’t opened yet'
      case 'expired':
        return 'This link has expired'
      case 'over':
        return 'This call is over'
      case 'revoked':
        return 'This invitation was withdrawn'
      default:
        return view.title
    }
  })

  function stopPreview() {
    for (const t of preview?.getTracks() ?? []) t.stop()
    preview = null
  }

  async function next(e: SubmitEvent) {
    e.preventDefault()
    error = null
    if (!name.trim()) {
      error = 'Enter your name so the others know who you are.'
      return
    }
    step = 'preview'
    mediaProblem = null
    try {
      preview = await getMedia({ video: true, audio: true })
    } catch (err) {
      const denied =
        err instanceof DOMException &&
        (err.name === 'NotAllowedError' || err.name === 'SecurityError')
      mediaProblem = denied
        ? 'Your browser blocked the camera and microphone. Allow them for this page (the icon in the address bar), or join without them.'
        : `Your camera or microphone did not start (${err instanceof Error ? err.message : String(err)}). You can join without them.`
      micOn = false
      camOn = false
    }
  }

  function toggle(kind: 'audio' | 'video') {
    if (kind === 'audio') micOn = !micOn
    else camOn = !camOn
    for (const t of preview?.getTracks() ?? [])
      if (t.kind === kind) t.enabled = kind === 'audio' ? micOn : camOn
  }

  function join() {
    if (!view) return
    stopPreview()
    const a = makeActive(() => name.trim())
    const t = makeTranscription(a, view.identity)
    t.connect()
    active = a
    transcription = t
    refresher = setInterval(() => {
      if (a.inCall)
        a.refresh().catch((err: unknown) =>
          console.error('[calls] refreshing the guest call failed', err),
        )
    }, REFRESH_MS)
    const c = makeChat && call ? makeChat(view.identity, call.id) : null
    chat = c
    if (c) chatRefresher = setInterval(() => a.inCall && void c.catchUp(), CHAT_REFRESH_MS)
    step = 'call'
  }

  function leaveCall() {
    clearInterval(refresher)
    clearInterval(chatRefresher)
    active?.close()
    transcription?.close()
  }

  function back() {
    leaveCall()
    active = null
    transcription = null
    chat = null
    step = 'name'
  }

  function attach(node: HTMLVideoElement, stream: MediaStream) {
    node.srcObject = stream
    return {
      destroy() {
        node.srcObject = null
      },
    }
  }

  onDestroy(() => {
    stopPreview()
    leaveCall()
  })
</script>

<div class="contents" data-testid="guest-page">
  {#if step === 'call' && active && call && view}
    <div class="flex h-dvh flex-col" data-testid="guest-call">
      <CallView
        {active}
        {call}
        me={view.identity}
        leaveLabel="Back"
        onleave={back}
        onhungup={() => {}}
        onopen={() => {}}
        startWith={{ microphone: micOn, camera: camOn }}
        {transcription}
        {chat}
        chatDictation={false}
      />
    </div>
  {:else}
    <PublicFrame
      title={headline}
      subtitle={view && view.status === 'ok'
        ? `${view.hostName}${company} invited you to a video call.`
        : null}
    >
      <div
        data-testid="guest-state"
        data-status={view ? view.status : 'not_found'}
        class="text-center text-sm text-muted-foreground"
      >
        {#if !view}
          <p>
            Check that you opened the whole link from your invitation, or ask the person who invited
            you for a new one.
          </p>
        {:else if view.status === 'too_early'}
          <p>
            <strong class="text-foreground">{view.title}</strong> starts {dayFmt.format(
              new Date(view.scheduledStart),
            )}. The call opens at
            {timeFmt.format(new Date(view.opensAt))} — come back then with the same link.
          </p>
        {:else if view.status === 'expired'}
          <p>
            It worked until {dayFmt.format(new Date(view.closesAt))}. Ask {view.hostName} for a new invitation.
          </p>
        {:else if view.status === 'over'}
          <p>{view.hostName} ended <strong class="text-foreground">{view.title}</strong>.</p>
        {:else if view.status === 'revoked'}
          <p>
            {view.hostName} withdrew your invitation to
            <strong class="text-foreground">{view.title}</strong>.
          </p>
        {:else}
          <p>
            {dayFmt.format(new Date(view.scheduledStart))} – {timeFmt.format(
              new Date(view.scheduledEnd),
            )}
          </p>
        {/if}
      </div>

      {#if view && view.status === 'ok'}
        {#if step === 'name'}
          <form class="mt-6 flex flex-col gap-3" onsubmit={next} novalidate>
            <div class="flex flex-col gap-1.5">
              <Label for="guest-name">Your name</Label>
              <Input
                id="guest-name"
                bind:value={name}
                maxlength={80}
                autocomplete="name"
                data-testid="guest-name"
              />
            </div>
            {#if error}<ErrorNotice
                testid="guest-error"
                {error}
                attempted="A guest joining a call from their link"
              />{/if}
            <Button type="submit" data-testid="guest-continue">Continue</Button>
            <p class="text-center text-xs text-muted-foreground">
              No account, no install — the call runs in this browser. You join as a guest.
            </p>
          </form>
        {:else}
          <div class="mt-6 flex flex-col gap-3" data-testid="guest-preview">
            <div class="relative aspect-video overflow-hidden rounded-xl bg-neutral-900">
              {#if preview && camOn}
                <video
                  use:attach={preview}
                  autoplay
                  playsinline
                  muted
                  class="size-full -scale-x-100 object-cover"
                  data-testid="guest-preview-video"
                ></video>
              {:else}
                <div class="grid size-full place-items-center text-sm text-neutral-400">
                  Camera off
                </div>
              {/if}
              <span
                class="absolute bottom-2 left-2 rounded-md bg-black/60 px-2 py-1 text-xs font-medium text-white"
                >{name.trim()}</span
              >
            </div>
            <div class="flex justify-center gap-2">
              <button
                type="button"
                class={[
                  'grid size-11 place-items-center rounded-full',
                  micOn ? 'bg-foreground/[0.08]' : 'bg-foreground text-background',
                ]}
                aria-label={micOn ? 'Mute' : 'Unmute'}
                aria-pressed={!micOn}
                disabled={!preview}
                onclick={() => toggle('audio')}
                >{#if micOn}<Mic class="size-5" />{:else}<MicOff class="size-5" />{/if}</button
              >
              <button
                type="button"
                class={[
                  'grid size-11 place-items-center rounded-full',
                  camOn ? 'bg-foreground/[0.08]' : 'bg-foreground text-background',
                ]}
                aria-label={camOn ? 'Turn camera off' : 'Turn camera on'}
                aria-pressed={!camOn}
                disabled={!preview}
                onclick={() => toggle('video')}
                >{#if camOn}<Video class="size-5" />{:else}<VideoOff class="size-5" />{/if}</button
              >
            </div>
            {#if mediaProblem}<p
                class="text-sm text-muted-foreground"
                role="status"
                data-testid="guest-media-problem"
              >
                {mediaProblem}
              </p>{/if}
            <p
              class="text-center text-xs text-muted-foreground"
              data-testid="guest-transcript-notice"
            >
              This call is transcribed: what you say is written down for the people in the call. You
              can turn it off for your microphone in the call.
            </p>
            <Button type="button" onclick={join} data-testid="guest-join">Join the call</Button>
            <button
              type="button"
              class="text-xs text-muted-foreground hover:text-foreground"
              onclick={() => (stopPreview(), (step = 'name'))}>Change name</button
            >
          </div>
        {/if}
      {/if}
    </PublicFrame>
  {/if}
</div>
