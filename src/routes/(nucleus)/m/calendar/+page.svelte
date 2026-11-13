<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- view/date links add a query string to resolve() */
  import type { EventDraft } from '../../../../../modules/calendar/form'
  import type { OccurrenceDto, Visibility } from '../../../../../modules/calendar/types'
  import type { PageProps } from './$types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import PageFrame from '$lib/components/page/page-frame.svelte'
  import PageHeader from '$lib/components/page/page-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { docTitle } from '$lib/shell/title'
  import { editDraft, newDraft } from '../../../../../modules/calendar/form'
  import { VISIBILITIES, VISIBILITY_COPY } from '../../../../../modules/calendar/types'
  import AvailabilityPanel from '../../../../../modules/calendar/ui/availability-panel.svelte'
  import CalendarViews from '../../../../../modules/calendar/ui/calendar-views.svelte'
  import EventDialog from '../../../../../modules/calendar/ui/event-dialog.svelte'
  import { shiftDate, VIEW_LABELS, VIEWS, type View } from '../../../../../modules/calendar/ui/layout'

  /** /m/calendar: your calendar by day, week or month; the event dialog; colleagues' availability. */
  let { data, form }: PageProps = $props()

  const base = resolve('/m/calendar')

  /** The address for a view and day, keeping the people picked for availability. */
  function href(view: View, date: string): string {
    const q = [`view=${view}`, `date=${date}`, ...data.availability.selected.map((id) => `with=${encodeURIComponent(id)}`)]
    return `${base}?${q.join('&')}`
  }

  let draft = $state<EventDraft | null>(null)
  let dialogOpen = $state(false)
  /** Bumped per opening, so the dialog starts fresh from its draft. */
  let opened = $state(0)

  /** The form result when the dialog opened: an older failure is not this dialog's. */
  let formAtOpen = $state<PageProps['form']>(null)

  function show(next: EventDraft) {
    draft = next
    formAtOpen = form
    opened += 1
    dialogOpen = true
  }
  const onopen = (o: OccurrenceDto) => show(editDraft(o))
  const oncreate = (day: string, time: string | null) =>
    show(newDraft({ day, time, timeZone: data.timeZone, visibility: data.defaultVisibility as Visibility }))

  const dialogError = $derived(
    dialogOpen && form !== formAtOpen && form && 'error' in form && typeof form.error === 'string' && (form.action === 'save' || form.action === 'delete') ? form.error : null,
  )
  const prefsError = $derived(form && 'error' in form && form.action === 'preferences' && typeof form.error === 'string' ? form.error : null)
  const selectClass = 'border-input bg-background h-8 rounded-md border px-2 text-xs'
</script>

<svelte:head><title>{docTitle('Calendar')}</title></svelte:head>

<PageFrame testid="calendar-area">
  <PageHeader title="Calendar" description="Your appointments, and when colleagues are free. Colleagues see only what you choose per event.">
    {#snippet actions()}
      <Button onclick={() => oncreate(data.date, null)} data-testid="calendar-new">New event</Button>
    {/snippet}
  </PageHeader>

  <div class="mt-5 flex flex-wrap items-center justify-between gap-3">
    <div class="flex items-center gap-1">
      <Button href={href(data.view, shiftDate(data.view, data.date, -1))} variant="outline" size="sm" aria-label="Previous {data.view}">‹</Button>
      <Button href={href(data.view, data.today)} variant="outline" size="sm">Today</Button>
      <Button href={href(data.view, shiftDate(data.view, data.date, 1))} variant="outline" size="sm" aria-label="Next {data.view}">›</Button>
      <h2 class="ml-2 text-sm font-semibold" data-testid="calendar-heading">{data.heading}</h2>
    </div>
    <nav class="flex rounded-md border border-border p-0.5" aria-label="Calendar view">
      {#each VIEWS as v (v)}
        <a
          href={href(v, data.date)}
          aria-current={data.view === v ? 'page' : undefined}
          class="rounded px-3 py-1 text-xs {data.view === v ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}"
          data-testid="calendar-view-{v}">{VIEW_LABELS[v]}</a
        >
      {/each}
    </nav>
  </div>

  <div class="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
    <div class="min-w-0">
      {#key `${data.view}:${data.date}`}
        <CalendarViews
          view={data.view}
          days={data.days}
          month={data.date.slice(0, 7)}
          today={data.today}
          timeZone={data.timeZone}
          occurrences={data.occurrences}
          dayHref={(day) => href('day', day)}
          {onopen}
          {oncreate}
        />
      {/key}
      <p class="mt-2 text-xs text-muted-foreground">Times in {data.timeZone.replaceAll('_', ' ')}.</p>
    </div>

    <aside class="grid content-start gap-6">
      <AvailabilityPanel
        members={data.members}
        selected={data.availability.selected}
        people={data.availability.people}
        days={data.availability.days}
        timeZone={data.timeZone}
        hidden={{ view: data.view, date: data.date }}
      />

      <form method="POST" action="?/preferences" class="grid gap-2" use:enhance={() => async ({ update }) => update({ reset: false })} data-testid="calendar-preferences">
        <label for="calendar-default-visibility" class="text-sm font-semibold">New events by default</label>
        <div class="flex flex-wrap items-center gap-2">
          <select id="calendar-default-visibility" name="defaultVisibility" class={selectClass} value={data.defaultVisibility}>
            {#each VISIBILITIES as v (v)}<option value={v}>{VISIBILITY_COPY[v].label}</option>{/each}
          </select>
          <Button type="submit" variant="outline" size="sm">Save</Button>
        </div>
        <p class="text-xs text-muted-foreground">{VISIBILITY_COPY[data.defaultVisibility as Visibility].colleagues}</p>
        {#if prefsError}<p class="text-xs text-destructive" role="alert">{prefsError}</p>{/if}
      </form>
    </aside>
  </div>
</PageFrame>

{#if draft}
  {#key opened}
    <EventDialog bind:open={dialogOpen} {draft} members={data.members} timeZones={data.timeZones} error={dialogError} />
  {/key}
{/if}
