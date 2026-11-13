<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- day links are built by the page (dayHref), which resolves them */
  import type { OccurrenceDto } from '../types'
  import { onMount } from 'svelte'
  import { localOf } from '../time'
  import { dayItems, longDay, MONTH_NAMES, placeTimed, WEEKDAY_NAMES, type View } from './layout'

  /**
   * The calendar itself, phone-first (375 px): a day as an hour grid, a week
   * as a list of its days, a month as six weeks of days with the first events
   * of each. Everything in the viewer's time zone. Tapping an event opens it
   * (`onopen`); tapping an empty hour or "Add" starts a new one (`oncreate`).
   */
  let {
    view,
    days,
    month,
    today,
    timeZone,
    occurrences,
    dayHref,
    onopen,
    oncreate,
  }: {
    view: View
    days: readonly string[]
    /** The month a month view is about (`YYYY-MM`): days outside it are dimmed. */
    month: string
    today: string
    timeZone: string
    occurrences: readonly OccurrenceDto[]
    /** The day view of a day. */
    dayHref: (day: string) => string
    onopen: (occurrence: OccurrenceDto) => void
    oncreate: (day: string, time: string | null) => void
  } = $props()

  const HOUR_PX = 48
  const MONTH_CHIPS = 3
  let scroller = $state<HTMLDivElement | null>(null)

  // The day view opens at 07:00 (or the first event, when earlier).
  onMount(() => {
    if (view !== 'day' || !scroller) return
    const first = placeTimed(dayItems(occurrences, days[0], timeZone).timed, days[0], timeZone)[0]
    scroller.scrollTop = (Math.min(7 * 60, first?.top ?? 7 * 60) / 60) * HOUR_PX
  })

  const time = (iso: string) => localOf(iso, timeZone).time
  const span = (o: OccurrenceDto) => (o.allDay ? 'All day' : `${time(o.start)} – ${time(o.end)}`)
  const label = (o: OccurrenceDto) => `${o.title}${o.status === 'tentative' ? ' (tentative)' : ''}`
  const shortDay = (day: string, i: number) => `${WEEKDAY_NAMES[i].slice(0, 3)} ${Number(day.slice(8))} ${MONTH_NAMES[Number(day.slice(5, 7)) - 1].slice(0, 3)}`
  const hours = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`)
  const chip =
    'block w-full truncate rounded px-1.5 py-0.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring'
  const tone = (o: OccurrenceDto) =>
    o.event?.canEdit === false ? 'border border-primary/40 bg-background text-foreground' : 'bg-primary/15 text-foreground hover:bg-primary/25'
</script>

{#if view === 'day'}
  {@const day = days[0]}
  {@const items = dayItems(occurrences, day, timeZone)}
  <section aria-label={longDay(day)} data-testid="calendar-day">
    {#if items.allDay.length > 0}
      <ul class="mb-2 grid gap-1" aria-label="All day">
        {#each items.allDay as o (o.key)}
          <li><button type="button" class="{chip} {tone(o)}" onclick={() => onopen(o)}>{label(o)} · All day</button></li>
        {/each}
      </ul>
    {/if}
    <div bind:this={scroller} class="relative max-h-[70dvh] overflow-y-auto rounded-md border border-border">
      <div class="relative" style="height: {24 * HOUR_PX}px">
        {#each hours as h, i (h)}
          <button
            type="button"
            class="absolute inset-x-0 flex items-start border-t border-border/60 pl-1 text-xs text-muted-foreground hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
            style="top: {i * HOUR_PX}px; height: {HOUR_PX}px"
            aria-label="New event at {h}"
            onclick={() => oncreate(day, h)}>{h}</button
          >
        {/each}
        {#each placeTimed(items.timed, day, timeZone) as p (p.item.key)}
          <button
            type="button"
            class="absolute overflow-hidden rounded px-1.5 py-0.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring {tone(p.item)}"
            style="top: {(p.top / 60) * HOUR_PX}px; height: {Math.max((p.height / 60) * HOUR_PX, 20)}px; left: calc(3rem + (100% - 3.25rem) * {p.column / p.columns}); width: calc((100% - 3.25rem) / {p.columns} - 2px)"
            data-testid="calendar-event"
            onclick={() => onopen(p.item)}
          >
            <span class="block truncate font-medium">{label(p.item)}</span>
            <span class="block truncate text-muted-foreground">{span(p.item)}</span>
          </button>
        {/each}
      </div>
    </div>
  </section>
{:else if view === 'week'}
  <ol class="grid gap-3" data-testid="calendar-week">
    {#each days as day, i (day)}
      {@const items = dayItems(occurrences, day, timeZone)}
      <li class="rounded-md border border-border p-2 {day === today ? 'border-primary/60' : ''}" aria-label={longDay(day)}>
        <div class="mb-1.5 flex items-center justify-between gap-2">
          <a href={dayHref(day)} class="text-sm font-medium hover:underline" aria-current={day === today ? 'date' : undefined}>
            {shortDay(day, i)}{day === today ? ' · Today' : ''}
          </a>
          <button type="button" class="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted" aria-label="New event on {longDay(day)}" onclick={() => oncreate(day, null)}>Add</button>
        </div>
        {#if items.allDay.length + items.timed.length === 0}
          <p class="text-xs text-muted-foreground">Nothing planned</p>
        {:else}
          <ul class="grid gap-1">
            {#each [...items.allDay, ...items.timed] as o (o.key)}
              <li>
                <button type="button" class="flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left text-sm {tone(o)}" data-testid="calendar-event" onclick={() => onopen(o)}>
                  <span class="w-24 shrink-0 text-xs text-muted-foreground tabular-nums">{items.allDay.includes(o) ? 'All day' : span(o)}</span>
                  <span class="min-w-0 truncate">{label(o)}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </li>
    {/each}
  </ol>
{:else}
  <div class="grid grid-cols-7 gap-px overflow-hidden rounded-md border border-border bg-border" role="grid" aria-label="Month" data-testid="calendar-month">
    <div class="contents" role="row">
      {#each WEEKDAY_NAMES as name (name)}
        <div role="columnheader" class="bg-muted/60 py-1 text-center text-xs font-medium text-muted-foreground" aria-label={name}>{name.slice(0, 2)}</div>
      {/each}
    </div>
    {#each Array.from({ length: days.length / 7 }, (_, w) => days.slice(w * 7, w * 7 + 7)) as week (week[0])}
      <div class="contents" role="row">
        {#each week as day (day)}
          {@const items = dayItems(occurrences, day, timeZone)}
          {@const list = [...items.allDay, ...items.timed]}
          <div role="gridcell" class="min-h-20 min-w-0 bg-background p-0.5 sm:min-h-24 sm:p-1 {day.slice(0, 7) === month ? '' : 'text-muted-foreground'}" aria-label={longDay(day)}>
            <div class="flex items-center justify-between">
              <a
                href={dayHref(day)}
                class="inline-flex size-6 items-center justify-center rounded-full text-xs hover:bg-muted {day === today ? 'bg-primary text-primary-foreground hover:bg-primary' : ''}"
                aria-current={day === today ? 'date' : undefined}>{Number(day.slice(8))}</a
              >
              <button type="button" class="hidden rounded px-1 text-xs text-muted-foreground hover:bg-muted sm:inline" aria-label="New event on {longDay(day)}" onclick={() => oncreate(day, null)}>+</button>
            </div>
            <ul class="mt-0.5 grid gap-0.5">
              {#each list.slice(0, MONTH_CHIPS) as o (o.key)}
                <li><button type="button" class="{chip} {tone(o)}" data-testid="calendar-event" onclick={() => onopen(o)}>{label(o)}</button></li>
              {/each}
            </ul>
            {#if list.length > MONTH_CHIPS}
              <a href={dayHref(day)} class="block px-1 text-xs text-muted-foreground hover:underline">+{list.length - MONTH_CHIPS} more</a>
            {/if}
          </div>
        {/each}
      </div>
    {/each}
  </div>
{/if}
