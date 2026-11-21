<script lang="ts">
  import type { ScheduleCall, ScheduleResult } from './client'
  import Check from '@lucide/svelte/icons/check'
  import Copy from '@lucide/svelte/icons/copy'
  import X from '@lucide/svelte/icons/x'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import UserAvatar from '$lib/components/user-avatar.svelte'

  /**
   * New call (Contribute proposal 844bab56). The default way is our own call
   * with guests by email: each guest gets a personal browser link (no
   * account, no install) that works from 15 minutes before the start until
   * 15 minutes after the end. Colleagues can be added too. Another
   * provider's link (Zoom, Teams, Google Meet …) is the second way: a
   * labelled field below, sent in the invitation instead of our link.
   *
   * After scheduling, every guest's link is shown once to copy, with whether
   * the invitation was emailed (or why not).
   */
  type Person = { id: string; name: string; email: string; image: string | null }
  let {
    people,
    ownCallsAvailable,
    onschedule,
    ondone,
  }: {
    /** Colleagues who can be invited (not me). */
    people: Person[]
    /** Our call server is set up; without it only another provider's link works. */
    ownCallsAvailable: boolean
    onschedule: (input: ScheduleCall) => Promise<ScheduleResult>
    ondone: () => void
  } = $props()

  const DURATIONS = [15, 30, 45, 60, 90, 120]
  // A syntax check to flag typos at once; the server validates every address again.
  const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/

  let guestList = $state<string[]>([])
  let guestDraft = $state('')
  let invitees = $state<string[]>([])
  let filter = $state('')
  let title = $state('')
  let when = $state<'now' | 'later'>('now')
  let startsAt = $state('')
  let duration = $state(60)
  let externalUrl = $state('')
  let error = $state<string | null>(null)
  let busy = $state(false)
  let done = $state<ScheduleResult | null>(null)
  let copied = $state<string | null>(null)

  const candidates = $derived(people.filter((p) => `${p.name} ${p.email}`.toLowerCase().includes(filter.trim().toLowerCase())))
  const isValid = (e: string) => EMAIL.test(e)

  /** Move what was typed into the list: addresses separated by commas, semicolons or spaces. */
  function takeDraft() {
    const parts = guestDraft
      .split(/[\s,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
    if (parts.length === 0) return
    guestList = [...guestList, ...parts.filter((p) => !guestList.includes(p))]
    guestDraft = ''
  }

  function onGuestKey(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      e.preventDefault()
      takeDraft()
    } else if (e.key === 'Backspace' && guestDraft === '' && guestList.length > 0) {
      guestList = guestList.slice(0, -1)
    }
  }

  const removeGuest = (g: string) => (guestList = guestList.filter((x) => x !== g))
  const toggle = (id: string) => (invitees = invitees.includes(id) ? invitees.filter((x) => x !== id) : [...invitees, id])

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    if (busy) return
    takeDraft()
    error = null
    const bad = guestList.filter((g) => !isValid(g))
    if (bad.length > 0) {
      error = `Not an email address: ${bad.join(', ')}`
      return
    }
    if (guestList.length === 0 && invitees.length === 0) {
      error = 'Add at least one guest or colleague.'
      return
    }
    const link = externalUrl.trim()
    if (!link && !ownCallsAvailable) {
      error = 'Video calls are not set up on this server. Add another call link (Zoom, Teams, Google Meet …) to invite people to that.'
      return
    }
    let start: string | null = null
    if (when === 'later') {
      const d = new Date(startsAt)
      if (!startsAt || Number.isNaN(d.getTime())) {
        error = 'Pick when the call starts.'
        return
      }
      start = d.toISOString()
    }
    busy = true
    try {
      done = await onschedule({
        guests: guestList,
        userIds: invitees,
        title: title.trim() || null,
        startsAt: start,
        durationMinutes: duration,
        externalUrl: link || null,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      copied = url
    } catch (err) {
      error = `Could not copy the link (${err instanceof Error ? err.message : String(err)}). Select it and copy it by hand.`
    }
  }

  const startFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
</script>

{#if done}
  <div class="flex flex-col gap-4" data-testid="new-call-done-view">
    <div>
      <h2 class="text-base font-semibold">{done.call.externalUrl ? 'Invitations ready' : when === 'now' ? 'Call started' : 'Call scheduled'}</h2>
      <p class="mt-1 text-sm text-muted-foreground">
        {done.call.title}{#if done.call.scheduledStart} · {startFmt.format(new Date(done.call.scheduledStart))}{/if}
      </p>
    </div>
    {#if !done.mailConfigured && done.invitations.length > 0}
      <p class="rounded-lg border border-border bg-foreground/[0.03] px-3 py-2 text-sm" role="status" data-testid="new-call-mail-off">
        Email isn’t set up — copy the link instead.
      </p>
    {/if}
    {#if done.invitations.length > 0}
      <ul class="flex flex-col divide-y divide-border rounded-lg border border-border">
        {#each done.invitations as inv (inv.guestId)}
          <li class="flex items-center gap-3 px-3 py-2" data-testid="new-call-invitation">
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium">{inv.email}</p>
              <p class={['truncate text-xs', inv.error ? 'text-destructive' : 'text-muted-foreground']}>
                {inv.emailed ? 'Emailed' : inv.error ? `Not sent: ${inv.error}` : 'Not emailed'}
              </p>
            </div>
            <Button type="button" size="sm" variant="outline" aria-label={`Copy link for ${inv.email}`} onclick={() => copy(inv.url)}>
              {#if copied === inv.url}<Check class="size-4" aria-hidden="true" /> Copied{:else}<Copy class="size-4" aria-hidden="true" /> Copy link{/if}
            </Button>
          </li>
        {/each}
      </ul>
      {#if !done.call.externalUrl}
        <p class="text-xs text-muted-foreground">Each link is personal and works from 15 minutes before the start until 15 minutes after the end.</p>
      {/if}
    {/if}
    {#if error}<p class="text-sm text-destructive" role="alert" data-testid="new-call-error">{error}</p>{/if}
    <div class="flex justify-end">
      <Button type="button" onclick={ondone} data-testid="new-call-done">Done</Button>
    </div>
  </div>
{:else}
  <form onsubmit={submit} class="flex flex-col gap-4" data-testid="new-call-form" novalidate>
    <div class="flex flex-col gap-1.5">
      <Label for="new-call-guests">Guests (email)</Label>
      <div class="flex flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 focus-within:ring-2 focus-within:ring-ring">
        {#each guestList as g (g)}
          <span
            class={[
              'inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs',
              isValid(g) ? 'bg-foreground/[0.06]' : 'bg-destructive/10 text-destructive',
            ]}
            data-testid="new-call-guest"
            data-email={g}
            data-valid={isValid(g) ? 'true' : 'false'}
          >
            <span class="truncate">{g}</span>
            <button type="button" class="opacity-60 hover:opacity-100" aria-label={`Remove ${g}`} onclick={() => removeGuest(g)}><X class="size-3" /></button>
          </span>
        {/each}
        <input
          id="new-call-guests"
          type="text"
          inputmode="email"
          autocomplete="off"
          class="min-w-40 flex-1 bg-transparent py-0.5 text-sm outline-none placeholder:text-muted-foreground"
          placeholder={guestList.length === 0 ? 'name@customer.com, …' : ''}
          bind:value={guestDraft}
          onkeydown={onGuestKey}
        />
      </div>
      <p class="text-xs text-muted-foreground">Guests join in the browser from their personal link — no account, no install.</p>
    </div>

    {#if people.length > 0}
      <div class="flex flex-col gap-1.5">
        <Label for="new-call-people-filter">Colleagues (optional)</Label>
        <Input dictation={false} id="new-call-people-filter" bind:value={filter} placeholder="Search people" />
        <div class="flex max-h-36 flex-col gap-0.5 overflow-y-auto rounded-md border border-border p-1.5" data-testid="new-call-people">
          {#if candidates.length === 0}<p class="p-1 text-xs text-muted-foreground">No one found.</p>{/if}
          {#each candidates as p (p.id)}
            <label class="flex items-center gap-2.5 rounded-md px-1.5 py-1 text-sm hover:bg-foreground/[0.04]">
              <input type="checkbox" checked={invitees.includes(p.id)} onchange={() => toggle(p.id)} aria-label={p.name} data-testid="new-call-person" data-email={p.email} />
              <UserAvatar name={p.name} image={p.image} size="sm" />
              <span class="min-w-0 flex-1 truncate">{p.name}</span>
            </label>
          {/each}
        </div>
      </div>
    {/if}

    <div class="flex flex-col gap-1.5">
      <Label for="new-call-title">Title (optional)</Label>
      <Input id="new-call-title" bind:value={title} placeholder="Kick-off with the customer" maxlength={200} />
    </div>

    <fieldset class="flex flex-col gap-2">
      <legend class="mb-1.5 text-sm font-medium">When</legend>
      <div class="flex flex-wrap items-center gap-4 text-sm">
        <label class="flex items-center gap-1.5"><input type="radio" name="new-call-when" value="now" bind:group={when} /> Now</label>
        <label class="flex items-center gap-1.5"><input type="radio" name="new-call-when" value="later" bind:group={when} /> Later</label>
      </div>
      <div class="flex flex-wrap gap-3">
        {#if when === 'later'}
          <div class="flex flex-col gap-1.5">
            <Label for="new-call-start">Starts</Label>
            <Input id="new-call-start" type="datetime-local" bind:value={startsAt} class="w-auto" />
          </div>
        {/if}
        <div class="flex flex-col gap-1.5">
          <Label for="new-call-duration">Duration</Label>
          <select
            id="new-call-duration"
            class="h-9 rounded-md border border-input bg-background px-2 text-sm"
            bind:value={duration}
          >
            {#each DURATIONS as m (m)}<option value={m}>{m < 60 ? `${m} min` : m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60} min`}</option>{/each}
          </select>
        </div>
      </div>
    </fieldset>

    <div class="flex flex-col gap-1.5 border-t border-border pt-4">
      <Label for="new-call-external">Other call link (Zoom, Teams, Google Meet …)</Label>
      <Input id="new-call-external" type="url" bind:value={externalUrl} placeholder="https://" />
      <p class="text-xs text-muted-foreground">Only if you want to use your own provider. Leave it empty for our video call.</p>
    </div>

    {#if error}<p class="text-sm text-destructive" role="alert" data-testid="new-call-error">{error}</p>{/if}
    <div class="flex justify-end gap-2">
      <Button type="button" variant="outline" onclick={ondone}>Cancel</Button>
      <Button type="submit" disabled={busy} data-testid="new-call-submit">{when === 'later' ? 'Schedule' : 'Start call'}</Button>
    </div>
  </form>
{/if}
