<script lang="ts">
  import type { PageData } from './$types'
  import Hash from '@lucide/svelte/icons/hash'
  import PhoneIncoming from '@lucide/svelte/icons/phone-incoming'
  import PhoneMissed from '@lucide/svelte/icons/phone-missed'
  import PhoneOutgoing from '@lucide/svelte/icons/phone-outgoing'
  import Users from '@lucide/svelte/icons/users'
  import Video from '@lucide/svelte/icons/video'
  import { onDestroy, onMount } from 'svelte'
  import { goto, invalidate } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { callsClient, problemOf, type CallDto } from '$lib/calls/client'
  import { CALLS_DEPENDENCY, historyOf } from '$lib/calls/format'
  import { getLiveCalls } from '$lib/calls/live-calls.svelte'
  import PageFrame from '$lib/components/page/page-frame.svelte'
  import PageHeader from '$lib/components/page/page-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import UserAvatar from '$lib/components/user-avatar.svelte'
  import { docTitle } from '$lib/shell/title'

  /**
   * /calls (plan/video-calls.md §3): live calls to join or rejoin (from the
   * layout's call feed), my recent calls, and New meeting — pick people,
   * start a meeting, land on its call page.
   */
  let { data }: { data: PageData } = $props()

  const liveCalls = getLiveCalls()
  const client = callsClient()

  const isLive = (c: CallDto) => c.state === 'ringing' || c.state === 'active'
  // The feed is the truth once it is up; until then the load's live calls.
  const live = $derived(liveCalls.status === 'live' ? liveCalls.calls : data.calls.filter(isLive))
  const recent = $derived(data.calls.filter((c) => !isLive(c)))
  const others = $derived(data.people.filter((p) => p.id !== data.me))

  const openCall = (id: string) => goto(resolve(`/calls/${id}`))
  const conversationHref = (c: CallDto) => `${resolve('/messages')}?c=${encodeURIComponent(c.contextId ?? '')}`

  const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
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
  onMount(() => {
    liveIds = new Set(liveCalls.calls.map((c) => c.id))
    unsubscribe = liveCalls.subscribe(() => {
      const now = new Set(liveCalls.calls.map((c) => c.id))
      const ended = [...liveIds].some((id) => !now.has(id))
      liveIds = now
      if (ended) void invalidate(CALLS_DEPENDENCY)
    })
  })
  onDestroy(() => unsubscribe())

  // ── New meeting ──────────────────────────────────────────────────────────
  let meetingOpen = $state(false)
  let meetingPeople = $state<string[]>([])
  let meetingTitle = $state('')
  let meetingFilter = $state('')
  let meetingError = $state<string | null>(null)
  let starting = $state(false)
  const candidates = $derived(
    others.filter((p) => `${p.name} ${p.email}`.toLowerCase().includes(meetingFilter.trim().toLowerCase())),
  )

  function openMeeting() {
    meetingPeople = []
    meetingTitle = ''
    meetingFilter = ''
    meetingError = null
    meetingOpen = true
  }

  const toggle = (id: string) =>
    (meetingPeople = meetingPeople.includes(id) ? meetingPeople.filter((x) => x !== id) : [...meetingPeople, id])

  async function startMeeting(e: SubmitEvent) {
    e.preventDefault()
    if (meetingPeople.length === 0 || starting) return
    starting = true
    meetingError = null
    try {
      const call = await client.start({ contextKind: 'meeting', userIds: meetingPeople, title: meetingTitle.trim() || null })
      meetingOpen = false
      await openCall(call.id)
    } catch (err) {
      meetingError = problemOf(err).message
    } finally {
      starting = false
    }
  }
</script>

<svelte:head><title>{docTitle('Calls')}</title></svelte:head>

{#snippet contextIcon(c: CallDto)}
  {#if c.contextKind === 'channel'}<Hash class="size-3.5" aria-hidden="true" />{:else if c.contextKind === 'meeting'}<Users
      class="size-3.5"
      aria-hidden="true"
    />{/if}
{/snippet}

<PageFrame testid="calls">
  <PageHeader
    title="Calls"
    description="Video calls with your team. Call from a direct message or channel header, or start a meeting with anyone here."
  >
    {#snippet actions()}
      <Button onclick={openMeeting} disabled={data.notConfigured !== null} data-testid="calls-new-meeting">
        <Video class="size-4" aria-hidden="true" /> New meeting
      </Button>
    {/snippet}
  </PageHeader>

  {#if data.notConfigured}
    <p class="mt-6 max-w-2xl rounded-lg border border-border bg-foreground/[0.03] px-4 py-3 text-sm" role="status" data-testid="calls-not-configured">
      {data.notConfigured}. Video calls need the company's call server; an owner or admin can turn it on for this server.
    </p>
  {/if}

  {#if live.length > 0}
    <section class="mt-8 max-w-2xl" aria-labelledby="calls-live">
      <h2 id="calls-live" class="text-sm font-semibold text-muted-foreground">Live now</h2>
      <ul class="mt-2 flex flex-col gap-2" data-testid="calls-live">
        {#each live as c (c.id)}
          <li class="flex items-center gap-3 rounded-lg border border-emerald-600/30 bg-emerald-600/5 px-4 py-3" data-testid="calls-live-item" data-id={c.id}>
            <span class="relative grid size-9 shrink-0 place-items-center rounded-full bg-emerald-600 text-white">
              <Video class="size-4" aria-hidden="true" />
            </span>
            <div class="min-w-0 flex-1">
              <p class="flex items-center gap-1 truncate text-sm font-semibold">{@render contextIcon(c)}<span class="truncate">{c.title}</span></p>
              <p class="truncate text-xs text-muted-foreground">
                {c.state === 'ringing' ? `Ringing · started by ${c.startedByName}` : `In progress · ${inRoom(c)} in the call`}
              </p>
            </div>
            <Button size="sm" class="bg-emerald-600 text-white hover:bg-emerald-700" onclick={() => openCall(c.id)} data-testid="calls-join"
              >{c.participants.some((p) => p.userId === data.me && p.joinedAt !== null) ? 'Rejoin' : 'Join'}</Button
            >
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <section class="mt-8 max-w-2xl" aria-labelledby="calls-recent">
    <h2 id="calls-recent" class="text-sm font-semibold text-muted-foreground">Recent</h2>
    {#if recent.length === 0}
      <p class="mt-2 text-sm text-muted-foreground" data-testid="calls-empty">No calls yet. Your calls and meetings will be listed here.</p>
    {:else}
      <ul class="mt-2 divide-y divide-border rounded-lg border border-border" data-testid="calls-recent">
        {#each recent as c (c.id)}
          {@const h = historyOf(c, data.me)}
          <li class="flex items-center gap-3 px-4 py-3" data-testid="calls-recent-item" data-id={c.id} data-outcome={c.state}>
            <span
              class={[
                'grid size-8 shrink-0 place-items-center rounded-full',
                h.tone === 'missed' ? 'bg-destructive/10 text-destructive' : 'bg-foreground/[0.06] text-muted-foreground',
              ]}
            >
              {#if h.tone === 'missed'}<PhoneMissed class="size-4" aria-label="Missed" />{:else if h.direction === 'outgoing'}<PhoneOutgoing
                  class="size-4"
                  aria-label="Outgoing"
                />{:else}<PhoneIncoming class="size-4" aria-label="Incoming" />{/if}
            </span>
            <div class="min-w-0 flex-1">
              {#if c.contextKind === 'meeting'}
                <p class="flex items-center gap-1 truncate text-sm font-semibold">{@render contextIcon(c)}<span class="truncate">{c.title}</span></p>
              {:else}
                <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() plus a query string -->
                <a href={conversationHref(c)} class="flex items-center gap-1 truncate text-sm font-semibold hover:underline"
                  >{@render contextIcon(c)}<span class="truncate">{c.title}</span></a
                >
              {/if}
              <p class="truncate text-xs">
                <span class={h.tone === 'missed' ? 'font-medium text-destructive' : 'text-muted-foreground'} data-testid="calls-outcome">{h.outcome}</span>
                <span class="text-muted-foreground"> · <time datetime={c.startedAt} title={fullFmt.format(new Date(c.startedAt))}>{when(c.startedAt)}</time></span>
              </p>
            </div>
            <span class="hidden shrink-0 -space-x-1 sm:flex" aria-hidden="true">
              {#each c.participants.filter((p) => p.userId !== data.me).slice(0, 3) as p (p.userId)}
                <UserAvatar name={p.name} size="sm" class="ring-2 ring-background" />
              {/each}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</PageFrame>

<Dialog.Root bind:open={meetingOpen}>
  <Dialog.Content class="max-w-md">
    <form onsubmit={startMeeting} class="flex flex-col gap-4" data-testid="calls-meeting-form">
      <Dialog.Header>
        <Dialog.Title>New meeting</Dialog.Title>
        <Dialog.Description>Pick the people to invite. Their phones and browsers ring now.</Dialog.Description>
      </Dialog.Header>
      <div class="flex flex-col gap-1.5">
        <Label for="meeting-title">Title (optional)</Label>
        <Input id="meeting-title" bind:value={meetingTitle} placeholder="Weekly sync" maxlength={200} />
      </div>
      <Input bind:value={meetingFilter} placeholder="Search people" aria-label="Search people" />
      <div class="flex max-h-60 flex-col gap-0.5 overflow-y-auto rounded-md border border-border p-1.5" data-testid="calls-meeting-people">
        {#if candidates.length === 0}<p class="p-1 text-xs text-muted-foreground">No one found.</p>{/if}
        {#each candidates as p (p.id)}
          <label class="flex items-center gap-2.5 rounded-md px-1.5 py-1 text-sm hover:bg-foreground/[0.04]">
            <input type="checkbox" checked={meetingPeople.includes(p.id)} onchange={() => toggle(p.id)} data-testid="calls-meeting-person" data-email={p.email} />
            <UserAvatar name={p.name} image={p.image} size="sm" />
            <span class="min-w-0 flex-1">
              <span class="block truncate font-medium">{p.name}</span>
              <span class="block truncate text-xs text-muted-foreground">{p.email}</span>
            </span>
          </label>
        {/each}
      </div>
      {#if meetingError}<p class="text-sm text-destructive" role="alert" data-testid="calls-meeting-error">{meetingError}</p>{/if}
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => (meetingOpen = false)}>Cancel</Button>
        <Button type="submit" disabled={meetingPeople.length === 0 || starting} data-testid="calls-meeting-start">Start meeting</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
