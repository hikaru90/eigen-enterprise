<script lang="ts">
  import type { PageData } from './$types'
  import CalendarClock from '@lucide/svelte/icons/calendar-clock'
  import ExternalLink from '@lucide/svelte/icons/external-link'
  import FileText from '@lucide/svelte/icons/file-text'
  import Hash from '@lucide/svelte/icons/hash'
  import PhoneIncoming from '@lucide/svelte/icons/phone-incoming'
  import PhoneMissed from '@lucide/svelte/icons/phone-missed'
  import PhoneOutgoing from '@lucide/svelte/icons/phone-outgoing'
  import Users from '@lucide/svelte/icons/users'
  import Video from '@lucide/svelte/icons/video'
  import { onDestroy, onMount } from 'svelte'
  import { invalidate } from '$app/navigation'
  import { resolve } from '$app/paths'
  import CallNowButton from '$lib/calls/call-now-button.svelte'
  import { getCallPresence } from '$lib/calls/call-presence.svelte'
  import CallRowSummary from '$lib/calls/call-row-summary.svelte'
  import { openCallTab, reserveCallTab } from '$lib/calls/call-tab'
  import {
    CallRequestError,
    brainClient,
    callsClient,
    problemOf,
    shownProblemOf,
    type CallDto,
    type ScheduleCall,
    type ScheduleResult,
  } from '$lib/calls/client'
  import { CALLS_DEPENDENCY, historyOf } from '$lib/calls/format'
  import { getLiveCalls } from '$lib/calls/live-calls.svelte'
  import MeetingGuests from '$lib/calls/meeting-guests.svelte'
  import NewCallForm from '$lib/calls/new-call-form.svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import PageFrame from '$lib/components/page/page-frame.svelte'
  import PageHeader from '$lib/components/page/page-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import UserAvatar from '$lib/components/user-avatar.svelte'
  import type { ShownError } from '$lib/errors/agent-report'
  import { docTitle } from '$lib/shell/title'

  /**
   * /calls (plan/video-calls.md §3): live calls to join or rejoin (from the
   * layout's call feed), upcoming meetings, my recent calls, and New call —
   * guests by email first (proposal 844bab56), colleagues, now or later,
   * or another provider's link. Every call of our own opens in its own tab
   * (call-tab.ts); a call on another provider opens that provider's link.
   * The host manages guests (withdraw a link, invite more) from the call's row.
   */
  let { data }: { data: PageData } = $props()

  const liveCalls = getLiveCalls()
  const presence = getCallPresence()
  const client = callsClient()
  const brainApi = brainClient()

  const isLive = (c: CallDto) =>
    c.state === 'scheduled' || c.state === 'ringing' || c.state === 'active'
  /** The clock for "upcoming" (ticks each half minute; a booked meeting moves to Live now when it opens). */
  let nowMs = $state(Date.now())
  const OPENS_EARLY_MS = 15 * 60_000
  const upcomingCall = (c: CallDto) =>
    c.state === 'scheduled' &&
    c.scheduledStart !== null &&
    new Date(c.scheduledStart).getTime() - OPENS_EARLY_MS > nowMs
  // The feed is the truth once it is up; until then the load's live calls.
  const liveAll = $derived(
    liveCalls.status === 'live' ? liveCalls.calls : data.calls.filter(isLive),
  )
  const live = $derived(liveAll.filter((c) => !upcomingCall(c)))
  const upcoming = $derived(
    liveAll
      .filter(upcomingCall)
      .sort((a, b) => (a.scheduledStart ?? '').localeCompare(b.scheduledStart ?? '')),
  )
  const recent = $derived(data.calls.filter((c) => !isLive(c)))
  const others = $derived(data.people.filter((p) => p.id !== data.me))

  /** Join / Rejoin: the call's tab (focused when it is open already). One call at a time across tabs. */
  let joinError = $state<ShownError | null>(null)
  function joinCall(c: CallDto) {
    joinError = null
    if (c.externalUrl) {
      window.open(c.externalUrl, '_blank', 'noopener')
      return
    }
    const current = presence.current
    if (current && current.id !== c.id) {
      joinError = {
        error: `You're already in a call (${current.title}). Hang up first to join this one.`,
        agent: null,
      }
      return
    }
    try {
      openCallTab(c.id)
    } catch (err) {
      joinError = shownProblemOf(err)
    }
  }
  const conversationHref = (c: CallDto) =>
    `${resolve('/messages')}?c=${encodeURIComponent(c.contextId ?? '')}`

  const dayFmt = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
  const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' })
  function when(iso: string): string {
    const d = new Date(iso)
    const today = new Date()
    const yesterday = new Date(today.getTime() - 86_400_000)
    const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
    const day = same(d, today) ? 'Today' : same(d, yesterday) ? 'Yesterday' : dayFmt.format(d)
    return `${day}, ${timeFmt.format(d)}`
  }
  const inRoom = (c: CallDto) => c.participants.filter((p) => p.inRoom).length

  // A live call that ended (it left the feed): reload the history so it shows up there.
  let liveIds = new Set<string>()
  let unsubscribe = () => {}
  let clock: ReturnType<typeof setInterval> | undefined
  onMount(() => {
    clock = setInterval(() => (nowMs = Date.now()), 30_000)
    liveIds = new Set(liveCalls.calls.map((c) => c.id))
    unsubscribe = liveCalls.subscribe(() => {
      const now = new Set(liveCalls.calls.map((c) => c.id))
      const ended = [...liveIds].some((id) => !now.has(id))
      liveIds = now
      if (ended) void invalidate(CALLS_DEPENDENCY)
    })
  })
  onDestroy(() => {
    unsubscribe()
    clearInterval(clock)
  })

  // ── New call ─────────────────────────────────────────────────────────────
  let newOpen = $state(false)
  /** Bumped per opening: the form starts empty each time. */
  let newKey = $state(0)

  function openNew() {
    newKey++
    newOpen = true
  }

  /**
   * The form's submit (proposal 844bab56). A call of our own that starts now
   * opens its tab in the submit itself (popup blockers) — refused while I am
   * in another call; booked calls and calls on another provider open no tab.
   */
  async function scheduleCall(input: ScheduleCall): Promise<ScheduleResult> {
    const startsNow = input.startsAt === null && input.externalUrl === null
    let tab: ReturnType<typeof reserveCallTab> | null = null
    if (startsNow) {
      const current = presence.current
      if (current) {
        throw new CallRequestError({
          kind: 'failed',
          message: `You're already in a call (${current.title}). Hang up first to start another one.`,
          agent: null,
        })
      }
      try {
        tab = reserveCallTab()
      } catch (err) {
        throw new CallRequestError(problemOf(err))
      }
    }
    try {
      const out = await client.schedule(input)
      tab?.show(out.call.id)
      void invalidate(CALLS_DEPENDENCY)
      return out
    } catch (err) {
      tab?.cancel()
      throw new CallRequestError(problemOf(err))
    }
  }

  // ── Guests of a meeting I set up ─────────────────────────────────────────
  let guestsOf = $state<CallDto | null>(null)
  const hosting = (c: CallDto) => c.startedBy === data.me && c.scheduledEnd !== null
  const whenFmt = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })
</script>

<svelte:head><title>{docTitle('Calls')}</title></svelte:head>

{#snippet contextIcon(c: CallDto)}
  {#if c.contextKind === 'channel'}<Hash
      class="size-3.5"
      aria-hidden="true"
    />{:else if c.contextKind === 'meeting'}<Users class="size-3.5" aria-hidden="true" />{/if}
{/snippet}

<PageFrame testid="calls">
  <PageHeader title="Calls" part="calls">
    {#snippet info()}
      <p>
        Video calls with your team and with people outside the company. Call from a direct message
        or channel header, or start a new call here: guests get a personal link that works in the
        browser.
      </p>
    {/snippet}
    {#snippet actions()}
      <div class="flex items-start gap-2">
        <CallNowButton schedule={scheduleCall} />
        <Button onclick={openNew} data-testid="calls-new-call">
          <Video class="size-4" aria-hidden="true" /> New call
        </Button>
      </div>
    {/snippet}
  </PageHeader>

  {#if data.notConfigured}
    <p
      class="mt-6 max-w-2xl rounded-lg border border-border bg-foreground/[0.03] px-4 py-3 text-sm"
      role="status"
      data-testid="calls-not-configured"
    >
      {data.notConfigured}. Video calls need the company's call server; an owner or admin can turn
      it on for this server. Until then you can still invite people to a call on another service
      (Zoom, Teams, Google Meet …).
    </p>
  {/if}

  {#if live.length > 0}
    <section class="mt-8 max-w-2xl" aria-labelledby="calls-live">
      <h2 id="calls-live" class="text-sm font-semibold text-muted-foreground">Live now</h2>
      {#if joinError}<ErrorNotice
          class="mt-2"
          testid="calls-join-error"
          error={joinError.error}
          agent={joinError.agent}
          attempted="Joining a live call from /calls"
        />{/if}
      <ul class="mt-2 flex flex-col gap-2" data-testid="calls-live">
        {#each live as c (c.id)}
          <li
            class="flex items-center gap-3 rounded-lg border border-emerald-600/30 bg-emerald-600/5 px-4 py-3"
            data-testid="calls-live-item"
            data-id={c.id}
          >
            <span
              class="relative grid size-9 shrink-0 place-items-center rounded-full bg-emerald-600 text-white"
            >
              <Video class="size-4" aria-hidden="true" />
            </span>
            <div class="min-w-0 flex-1">
              <p class="flex items-center gap-1 truncate text-sm font-semibold">
                {@render contextIcon(c)}<span class="truncate">{c.title}</span>
              </p>
              <p class="truncate text-xs text-muted-foreground">
                {c.externalUrl
                  ? 'On another service'
                  : c.state === 'ringing'
                    ? `Ringing · started by ${c.startedByName}`
                    : c.state === 'scheduled'
                      ? `Open to join · ${c.scheduledEnd ? `until ${timeFmt.format(new Date(c.scheduledEnd))}` : ''}`
                      : `In progress · ${inRoom(c)} in the call`}
              </p>
            </div>
            {#if hosting(c)}
              <Button
                size="sm"
                variant="outline"
                onclick={() => (guestsOf = c)}
                data-testid="calls-guests"
                >Guests{c.guests.length ? ` (${c.guests.length})` : ''}</Button
              >
            {/if}
            <Button
              size="sm"
              class="bg-emerald-600 text-white hover:bg-emerald-700"
              onclick={() => joinCall(c)}
              data-testid="calls-join"
              >{#if c.externalUrl}<ExternalLink class="size-3.5" aria-hidden="true" /> Open link{:else}{c.participants.some(
                  (p) => p.userId === data.me && p.joinedAt !== null,
                )
                  ? 'Rejoin'
                  : 'Join'}{/if}</Button
            >
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if upcoming.length > 0}
    <section class="mt-8 max-w-2xl" aria-labelledby="calls-upcoming">
      <h2 id="calls-upcoming" class="text-sm font-semibold text-muted-foreground">Upcoming</h2>
      <ul
        class="mt-2 divide-y divide-border rounded-lg border border-border"
        data-testid="calls-upcoming"
      >
        {#each upcoming as c (c.id)}
          <li
            class="flex items-center gap-3 px-4 py-3"
            data-testid="calls-upcoming-item"
            data-id={c.id}
          >
            <span
              class="grid size-8 shrink-0 place-items-center rounded-full bg-foreground/[0.06] text-muted-foreground"
            >
              <CalendarClock class="size-4" aria-hidden="true" />
            </span>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold">{c.title}</p>
              <p class="truncate text-xs text-muted-foreground">
                <time datetime={c.scheduledStart}
                  >{whenFmt.format(new Date(c.scheduledStart!))}</time
                >
                {#if c.guests.length}· {c.guests.filter((g) => !g.revoked).length} guest{c.guests.filter(
                    (g) => !g.revoked,
                  ).length === 1
                    ? ''
                    : 's'}{/if}
                {#if c.externalUrl}· on another service{/if}
              </p>
            </div>
            {#if hosting(c)}
              <Button
                size="sm"
                variant="outline"
                onclick={() => (guestsOf = c)}
                data-testid="calls-guests">Guests</Button
              >
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <section class="mt-8 max-w-2xl" aria-labelledby="calls-recent">
    <h2 id="calls-recent" class="text-sm font-semibold text-muted-foreground">Recent</h2>
    {#if recent.length === 0}
      <p class="mt-2 text-sm text-muted-foreground" data-testid="calls-empty">
        No calls yet. Your calls and meetings will be listed here.
      </p>
    {:else}
      <ul
        class="mt-2 divide-y divide-border rounded-lg border border-border"
        data-testid="calls-recent"
      >
        {#each recent as c (c.id)}
          {@const h = historyOf(c, data.me)}
          <li
            class="flex flex-wrap items-center gap-3 px-4 py-3"
            data-testid="calls-recent-item"
            data-id={c.id}
            data-outcome={c.state}
          >
            <span
              class={[
                'grid size-8 shrink-0 place-items-center rounded-full',
                h.tone === 'missed'
                  ? 'bg-destructive/10 text-destructive'
                  : 'bg-foreground/[0.06] text-muted-foreground',
              ]}
            >
              {#if h.tone === 'missed'}<PhoneMissed
                  class="size-4"
                  aria-label="Missed"
                />{:else if h.direction === 'outgoing'}<PhoneOutgoing
                  class="size-4"
                  aria-label="Outgoing"
                />{:else}<PhoneIncoming class="size-4" aria-label="Incoming" />{/if}
            </span>
            <div class="min-w-0 flex-1">
              {#if c.contextKind === 'meeting'}
                <p class="flex items-center gap-1 truncate text-sm font-semibold">
                  {@render contextIcon(c)}<span class="truncate">{c.title}</span>
                </p>
              {:else}
                <!-- eslint-disable svelte/no-navigation-without-resolve -- resolve() plus a query string -->
                <a
                  href={conversationHref(c)}
                  class="flex items-center gap-1 truncate text-sm font-semibold hover:underline"
                  >{@render contextIcon(c)}<span class="truncate">{c.title}</span></a
                >
                <!-- eslint-enable svelte/no-navigation-without-resolve -->
              {/if}
              <p class="truncate text-xs">
                <span
                  class={h.tone === 'missed'
                    ? 'font-medium text-destructive'
                    : 'text-muted-foreground'}
                  data-testid="calls-outcome">{h.outcome}</span
                >
                <span class="text-muted-foreground">
                  · <time datetime={c.startedAt} title={fullFmt.format(new Date(c.startedAt))}
                    >{when(c.startedAt)}</time
                  ></span
                >
              </p>
            </div>
            <span class="hidden shrink-0 -space-x-1 sm:flex" aria-hidden="true">
              {#each c.participants.filter((p) => p.userId !== data.me).slice(0, 3) as p (p.userId)}
                <UserAvatar name={p.name} size="sm" class="ring-2 ring-background" />
              {/each}
            </span>
            {#if data.transcripts[c.id]}
              <a
                href={resolve('/(nucleus)/calls/[id]/transcript', { id: c.id })}
                class="inline-flex shrink-0 items-center gap-1 rounded-full bg-foreground/[0.06] px-2.5 py-1 text-xs font-medium hover:bg-foreground/[0.1]"
                data-testid="calls-transcript-link"
                ><FileText class="size-3.5" aria-hidden="true" />Transcript</a
              >
            {/if}
            {#if c.id in data.summaries}
              <div class="basis-full pl-11">
                <CallRowSummary callId={c.id} recap={data.summaries[c.id]} client={brainApi} />
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</PageFrame>

<Dialog.Root bind:open={newOpen}>
  <Dialog.Content class="max-h-[90dvh] max-w-lg overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>New call</Dialog.Title>
      <Dialog.Description>Invite guests by email and colleagues — now or later.</Dialog.Description>
    </Dialog.Header>
    {#key newKey}
      <NewCallForm
        people={others}
        ownCallsAvailable={data.notConfigured === null}
        onschedule={scheduleCall}
        ondone={() => (newOpen = false)}
      />
    {/key}
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root open={guestsOf !== null} onOpenChange={(o) => !o && (guestsOf = null)}>
  <Dialog.Content class="max-h-[90dvh] max-w-lg overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>Guests</Dialog.Title>
      <Dialog.Description>{guestsOf?.title}</Dialog.Description>
    </Dialog.Header>
    {#if guestsOf}
      {#key guestsOf.id}
        <MeetingGuests
          call={guestsOf}
          {client}
          onchange={(c) => {
            guestsOf = c
            void invalidate(CALLS_DEPENDENCY)
          }}
        />
      {/key}
    {/if}
  </Dialog.Content>
</Dialog.Root>
