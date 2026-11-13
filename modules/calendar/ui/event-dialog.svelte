<script lang="ts">
  import type { EventDraft, RepeatForm } from '../form'
  import type { MemberOption, Visibility } from '../types'
  import { untrack } from 'svelte'
  import { enhance } from '$app/forms'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Textarea } from '$lib/components/ui/textarea'
  import { WEEKDAYS, type Weekday } from '../recurrence'
  import { CALENDAR_LIMITS, VISIBILITIES, VISIBILITY_COPY } from '../types'
  import { longDay, WEEKDAY_NAMES } from './layout'

  /**
   * Create or change an event (plan/calendar.md K2): title, time (or all
   * day), time zone, location, repeat, who sees it — company, busy (the
   * default) or private — guests from the company, notes. For an instance of
   * a repeating event it asks first: this event or all events (the date
   * fields follow the choice). Guests of someone else's event see it read
   * only. Nothing is saved until Save.
   */
  let {
    open = $bindable(false),
    draft,
    members,
    timeZones,
    error = null,
    onsaved,
  }: {
    open?: boolean
    draft: EventDraft
    /** Colleagues who can be invited (not the person themselves). */
    members: readonly MemberOption[]
    /** IANA zones to offer. */
    timeZones: readonly string[]
    /** The last save's or delete's failure, from the page's form result. */
    error?: string | null
    /** After a successful save or delete (the page data is already refreshed). */
    onsaved?: () => void
  } = $props()

  const start = untrack(() => draft)
  const zones = untrack(() => (timeZones.includes(start.timeZone) ? timeZones : [start.timeZone, ...timeZones]))
  const instance = { startDay: start.startDay, startTime: start.startTime, endDay: start.endDay, endTime: start.endTime }

  let scope = $state<'one' | 'all'>('one')
  let f = $state({
    title: start.title,
    allDay: start.allDay,
    ...instance,
    timeZone: start.timeZone,
    location: start.location,
    notes: start.notes,
    visibility: start.visibility as Visibility,
  })
  let repeat = $state<RepeatForm>({ ...start.repeat, days: [...start.repeat.days] })
  let repeatChoice = $state<string>(start.repeat.custom ? 'custom' : start.repeat.freq)
  let guests = $state<string[]>([...start.guests])
  let external = $state([...start.externalGuests])
  let confirmDelete = $state(false)

  const isNew = start.id === null
  const fromMail = start.proposalId !== null
  const forOne = $derived(start.inSeries && scope === 'one')
  const title = fromMail ? 'Appointment from mail' : isNew ? 'New event' : start.canEdit ? 'Edit event' : 'Event'

  /** "This event" shows the instance's time, "All events" the series' own. */
  function pickScope(next: 'one' | 'all') {
    scope = next
    const times = next === 'all' && start.series ? start.series : instance
    Object.assign(f, times)
  }

  function toggleDay(day: Weekday, on: boolean) {
    repeat.days = on ? WEEKDAYS.filter((d) => d === day || repeat.days.includes(d)) : repeat.days.filter((d) => d !== day)
  }

  const saved = () =>
    async ({ result, update }: { result: { type: string }; update: (o?: { reset?: boolean }) => Promise<void> }) => {
      await update({ reset: false })
      if (result.type === 'success') {
        open = false
        onsaved?.()
      }
    }

  const when = $derived(
    start.allDay
      ? start.startDay === start.endDay
        ? `${longDay(start.startDay)}, all day`
        : `${longDay(start.startDay)} – ${longDay(start.endDay)}, all day`
      : `${longDay(start.startDay)}, ${start.startTime} – ${start.endDay === start.startDay ? '' : `${longDay(start.endDay)}, `}${start.endTime}`,
  )
  const selectClass = 'border-input bg-background h-9 w-full rounded-md border px-2 text-sm'
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[92dvh] w-[calc(100vw-2rem)] max-w-lg overflow-y-auto p-4 sm:p-6" data-testid="event-dialog">
    <Dialog.Header>
      <Dialog.Title>{title}</Dialog.Title>
      <Dialog.Description>
        {#if !start.canEdit}
          On {start.ownerName}’s calendar — only they change it.
        {:else if fromMail}
          Not on your calendar yet. Saving adds it and sends the invitation to the guests outside the company.
        {:else}
          On your calendar. Colleagues see only what you choose below.
        {/if}
      </Dialog.Description>
    </Dialog.Header>

    {#if !start.canEdit}
      <dl class="grid gap-2 text-sm" data-testid="event-readonly">
        <div><dt class="sr-only">Title</dt><dd class="font-medium">{start.title}</dd></div>
        <div><dt class="sr-only">When</dt><dd>{when} <span class="text-muted-foreground">({start.timeZone})</span></dd></div>
        {#if start.location}<div><dt class="text-muted-foreground">Where</dt><dd>{start.location}</dd></div>{/if}
        {#if start.guestLabels.length > 0}
          <div>
            <dt class="text-muted-foreground">Guests</dt>
            <dd>{start.guestLabels.join(', ')}</dd>
          </div>
        {/if}
        {#if start.notes}<div><dt class="text-muted-foreground">Notes</dt><dd class="whitespace-pre-wrap">{start.notes}</dd></div>{/if}
      </dl>
      {#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
    {:else}
      <form method="POST" action="?/save" class="grid gap-4" data-testid="event-form" use:enhance={saved}>
        {#if start.id}<input type="hidden" name="id" value={start.id} />{/if}
        {#if start.proposalId}<input type="hidden" name="proposalId" value={start.proposalId} />{/if}
        {#if start.inSeries}
          <input type="hidden" name="scope" value={scope} />
          <input type="hidden" name="occurrenceStart" value={start.occurrenceStart} />
          <fieldset class="grid gap-1.5">
            <legend class="mb-1.5 text-sm font-medium">This is a repeating event. Change…</legend>
            <div class="flex flex-wrap gap-4 text-sm">
              <label class="flex items-center gap-2">
                <input type="radio" name="scopeChoice" value="one" checked={scope === 'one'} onchange={() => pickScope('one')} />
                This event
              </label>
              <label class="flex items-center gap-2">
                <input type="radio" name="scopeChoice" value="all" checked={scope === 'all'} onchange={() => pickScope('all')} />
                All events
              </label>
            </div>
            {#if scope === 'all'}
              <p class="text-xs text-muted-foreground">A new time or repeat for all events starts the series over: events you changed one by one go back to the series.</p>
            {/if}
          </fieldset>
        {/if}

        <div class="grid gap-1.5">
          <Label for="event-title">Title</Label>
          <Input id="event-title" name="title" required maxlength={CALENDAR_LIMITS.title} bind:value={f.title} />
        </div>

        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" name="allDay" bind:checked={f.allDay} />
          All day
        </label>

        <div class="grid grid-cols-2 gap-3">
          <div class="grid gap-1.5">
            <Label for="event-start-day">Starts</Label>
            <Input id="event-start-day" name="startDay" type="date" required bind:value={f.startDay} />
          </div>
          {#if !f.allDay}
            <div class="grid gap-1.5">
              <Label for="event-start-time">Start time</Label>
              <Input id="event-start-time" name="startTime" type="time" required bind:value={f.startTime} />
            </div>
          {/if}
          <div class="grid gap-1.5">
            <Label for="event-end-day">Ends</Label>
            <Input id="event-end-day" name="endDay" type="date" required bind:value={f.endDay} />
          </div>
          {#if !f.allDay}
            <div class="grid gap-1.5">
              <Label for="event-end-time">End time</Label>
              <Input id="event-end-time" name="endTime" type="time" required bind:value={f.endTime} />
            </div>
          {/if}
        </div>

        <div class="grid gap-1.5">
          <Label for="event-zone">Time zone</Label>
          <select id="event-zone" name="timeZone" class={selectClass} bind:value={f.timeZone}>
            {#each zones as zone (zone)}<option value={zone}>{zone.replaceAll('_', ' ')}</option>{/each}
          </select>
        </div>

        <div class="grid gap-1.5">
          <Label for="event-location">Location</Label>
          <Input id="event-location" name="location" maxlength={CALENDAR_LIMITS.location} placeholder="A room, an address or a link" bind:value={f.location} />
        </div>

        {#if !forOne}
          <fieldset class="grid gap-2" data-testid="event-repeat">
            <legend class="mb-1.5 text-sm font-medium">Repeat</legend>
            <select name="repeat" aria-label="Repeat" class={selectClass} bind:value={repeatChoice}>
              <option value="none">Does not repeat</option>
              <option value="DAILY">Daily</option>
              <option value="WEEKLY">Weekly</option>
              <option value="MONTHLY">Monthly</option>
              <option value="YEARLY">Yearly</option>
              {#if start.repeat.custom}<option value="custom">As it is ({start.repeat.custom})</option>{/if}
            </select>
            {#if start.repeat.custom}<input type="hidden" name="repeatCustom" value={start.repeat.custom} />{/if}
            {#if repeatChoice !== 'none' && repeatChoice !== 'custom'}
              <label class="flex items-center gap-2 text-sm">
                Every
                <Input name="repeatInterval" type="number" min="1" max="999" class="h-8 w-20" bind:value={repeat.interval} aria-label="Repeat every" />
                {repeatChoice === 'DAILY' ? 'days' : repeatChoice === 'WEEKLY' ? 'weeks' : repeatChoice === 'MONTHLY' ? 'months' : 'years'}
              </label>
              {#if repeatChoice === 'WEEKLY'}
                <div class="flex flex-wrap gap-1.5" role="group" aria-label="On these days">
                  {#each WEEKDAYS as day, i (day)}
                    <label class="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs">
                      <input
                        type="checkbox"
                        name="repeatDay"
                        value={day}
                        checked={repeat.days.includes(day)}
                        onchange={(e) => toggleDay(day, e.currentTarget.checked)}
                        aria-label={WEEKDAY_NAMES[i]}
                      />
                      {WEEKDAY_NAMES[i].slice(0, 2)}
                    </label>
                  {/each}
                </div>
              {/if}
              <div class="flex flex-wrap items-center gap-2 text-sm">
                <select name="repeatEnd" aria-label="Ends" class="{selectClass} w-auto" bind:value={repeat.end}>
                  <option value="never">Never ends</option>
                  <option value="on">Ends on</option>
                  <option value="after">Ends after</option>
                </select>
                {#if repeat.end === 'on'}
                  <Input name="repeatUntil" type="date" required class="h-9 w-auto" bind:value={repeat.until} aria-label="Last day" />
                {:else if repeat.end === 'after'}
                  <Input name="repeatCount" type="number" min="1" max="1000" required class="h-9 w-20" bind:value={repeat.count} aria-label="Times" /> times
                {/if}
              </div>
            {/if}
          </fieldset>
        {/if}

        <fieldset class="grid gap-2" data-testid="event-visibility">
          <legend class="mb-1.5 text-sm font-medium">What colleagues see</legend>
          {#each VISIBILITIES as v (v)}
            <label class="flex items-start gap-2 text-sm">
              <input type="radio" name="visibility" value={v} class="mt-1" bind:group={f.visibility} />
              <span><span class="font-medium">{VISIBILITY_COPY[v].label}</span> — <span class="text-muted-foreground">{VISIBILITY_COPY[v].colleagues}</span></span>
            </label>
          {/each}
        </fieldset>

        {#if !forOne}
          <fieldset class="grid gap-2" data-testid="event-guests">
            <legend class="mb-1.5 text-sm font-medium">Guests</legend>
            {#if members.length === 0 && external.length === 0}
              <p class="text-xs text-muted-foreground">No colleagues to invite yet.</p>
            {/if}
            <div class="grid max-h-40 gap-1.5 overflow-y-auto sm:grid-cols-2">
              {#each members as m (m.id)}
                <label class="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="guest" value={m.id} bind:group={guests} />
                  {m.name}
                </label>
              {/each}
            </div>
            {#each external as g (g.email)}
              <div class="flex items-center justify-between gap-2 text-sm" data-testid="event-external-guest">
                <input type="hidden" name="guestEmail" value={g.email} />
                <input type="hidden" name="guestEmailName" value={g.name ?? ''} />
                <span class="min-w-0 truncate">{g.name ? `${g.name} <${g.email}>` : g.email}</span>
                <Button type="button" variant="ghost" size="sm" onclick={() => (external = external.filter((x) => x.email !== g.email))}>Remove</Button>
              </div>
            {/each}
          </fieldset>
        {/if}

        <div class="grid gap-1.5">
          <Label for="event-notes">Notes</Label>
          <Textarea id="event-notes" name="notes" rows={3} maxlength={CALENDAR_LIMITS.notes} bind:value={f.notes} />
        </div>

        {#if error}<p class="text-sm text-destructive" role="alert" data-testid="event-error">{error}</p>{/if}

        <div class="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
          <Button type="submit">{fromMail ? (external.length > 0 ? 'Save and send invitation' : 'Save') : 'Save'}</Button>
        </div>
      </form>

      {#if !isNew}
        <form method="POST" action="?/delete" class="flex flex-wrap items-center gap-2 border-t border-border pt-3" use:enhance={saved}>
          <input type="hidden" name="id" value={start.id} />
          {#if forOne}<input type="hidden" name="occurrenceStart" value={start.occurrenceStart} />{/if}
          {#if confirmDelete}
            <span class="text-sm">{forOne ? 'Delete this event?' : start.inSeries ? 'Delete all events of this series?' : 'Delete this event?'}</span>
            <Button type="submit" variant="destructive" size="sm">Yes, delete</Button>
            <Button type="button" variant="ghost" size="sm" onclick={() => (confirmDelete = false)}>Keep it</Button>
          {:else}
            <Button type="button" variant="ghost" size="sm" class="text-destructive" onclick={() => (confirmDelete = true)}>
              {forOne ? 'Delete this event' : start.inSeries ? 'Delete all events' : 'Delete'}
            </Button>
          {/if}
        </form>
      {/if}
    {/if}
  </Dialog.Content>
</Dialog.Root>
