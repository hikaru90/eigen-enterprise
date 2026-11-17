<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- day links are built by the page (dayHref), which resolves them */
  import type { OccurrenceDto } from '../types'
  import { onMount } from 'svelte'
  import type { Swipe } from '$lib/gestures/swipe'
  import { swipe } from '$lib/gestures/swipe-action'
  import { localOf } from '../time'
  import { dayItems, longDay, MONTH_NAMES, placeTimed, stepWeek, WEEKDAY_NAMES, weekPages, weekStart, type View } from './layout'

  /**
   * The calendar itself, phone-first (375 px): a day as an hour grid, a week
   * as the classic time grid — its days side by side, hours down, all-day
   * events on top (Contribute a02c5126; on a phone three days at a time,
   * paged) — a month as six weeks of days with the first events of each.
   * Everything in the viewer's time zone. Tapping an event opens it
   * (`onopen`); tapping an empty hour or "+" starts a new one (`oncreate`).
   * On touch screens a swipe left / right moves to the next / previous
   * period (`onshift`); in a paged week it first pages through the week's days.
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
    onshift,
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
    /** The next (1) or previous (-1) day, week or month. */
    onshift: (direction: -1 | 1) => void
  } = $props()

  const HOUR_PX = 48
  const MONTH_CHIPS = 3
  /** Days side by side in a week on a phone (below 640 px). */
  const PHONE_DAYS = 3
  let scroller = $state<HTMLDivElement | null>(null)

  /** A week shows `visible` of its days from `offset` (all seven, except on a phone). */
  let visible = $state(7)
  let offset = $state(0)
  const lastPage = $derived(weekPages(days.length, visible).at(-1) ?? 0)

  onMount(() => {
    // Day and week open at 07:00 (or the first event, when earlier).
    if (view !== 'month' && scroller) {
      const tops = days.flatMap((d) => placeTimed(dayItems(occurrences, d, timeZone).timed, d, timeZone).map((p) => p.top))
      scroller.scrollTop = (Math.min(7 * 60, ...tops) / 60) * HOUR_PX
    }
    if (view !== 'week') return
    const phone = window.matchMedia('(max-width: 639px)')
    const fit = () => {
      visible = phone.matches ? PHONE_DAYS : 7
      offset = weekStart(days, today, visible)
    }
    fit()
    phone.addEventListener('change', fit)
    return () => phone.removeEventListener('change', fit)
  })

  function page(direction: -1 | 1): boolean {
    const step = stepWeek(offset, days.length, visible, direction)
    if ('shift' in step) return false
    offset = step.offset
    return true
  }

  // Swipe left = forward in time, like turning a page.
  function onswipe(s: Swipe): void {
    const direction = s.direction === 'left' ? 1 : -1
    if (view === 'week' && page(direction)) return
    onshift(direction)
  }

  const time = (iso: string) => localOf(iso, timeZone).time
  const span = (o: OccurrenceDto) => (o.allDay ? 'All day' : `${time(o.start)} – ${time(o.end)}`)
  const label = (o: OccurrenceDto) => `${o.title}${o.status === 'tentative' ? ' (tentative)' : ''}`
  const hours = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`)
  const chip =
    'block w-full truncate rounded px-1.5 py-0.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring'
  const tone = (o: OccurrenceDto) =>
    o.event?.canEdit === false ? 'border border-primary/40 bg-background text-foreground' : 'bg-primary/15 text-foreground hover:bg-primary/25'
  const eventBox = 'absolute overflow-hidden rounded px-1.5 py-0.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring'
  const pageButton = 'grid size-6 place-items-center rounded-full text-sm text-muted-foreground hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent'
</script>

<div use:swipe={{ onswipe }} style="touch-action: pan-y" data-testid="calendar-views">
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
              class="{eventBox} {tone(p.item)}"
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
    {@const shown = days.slice(offset, offset + visible)}
    <!-- The grid is the view (inline, not a utility): the hour gutter, then the days side by side. -->
    {@const columns = `display: grid; grid-template-columns: 3rem repeat(${shown.length}, minmax(0, 1fr))`}
    {@const allDay = shown.map((day) => dayItems(occurrences, day, timeZone).allDay)}
    <section aria-label="Week" data-testid="calendar-week" data-days={shown.length}>
      <div bind:this={scroller} class="relative max-h-[70dvh] overflow-y-auto rounded-md border border-border">
        <!-- The days' heads and their all-day events stay on top while the hours scroll. -->
        <div class="sticky top-0 z-10 border-b border-border bg-background">
          <div style={columns}>
            <div class="flex items-center justify-center">
              {#if visible < days.length}
                <button type="button" class={pageButton} aria-label="Earlier days" disabled={offset === 0} onclick={() => page(-1)}>‹</button>
                <button type="button" class={pageButton} aria-label="Later days" disabled={offset >= lastPage} onclick={() => page(1)}>›</button>
              {/if}
            </div>
            {#each shown as day (day)}
              {@const i = days.indexOf(day)}
              <div class="flex min-w-0 items-center justify-between gap-1 border-l border-border/60 py-1 pr-0.5 pl-1.5" data-testid="calendar-week-head">
                <a href={dayHref(day)} class="flex min-w-0 items-center gap-1 rounded text-xs hover:underline" aria-current={day === today ? 'date' : undefined} aria-label={longDay(day)}>
                  <span class="truncate text-muted-foreground">{WEEKDAY_NAMES[i].slice(0, 3)}</span>
                  <span class="inline-flex size-6 shrink-0 items-center justify-center rounded-full font-medium {day === today ? 'bg-primary text-primary-foreground' : ''}"
                    >{Number(day.slice(8))}</span
                  >
                  <span class="sr-only">{MONTH_NAMES[Number(day.slice(5, 7)) - 1]}</span>
                </a>
                <button type="button" class="shrink-0 rounded px-1 text-xs text-muted-foreground hover:bg-muted" aria-label="New event on {longDay(day)}" onclick={() => oncreate(day, null)}>+</button>
              </div>
            {/each}
          </div>
          {#if allDay.some((list) => list.length > 0)}
            <div class="border-t border-border/60" style={columns}>
              <div class="px-1 py-1 text-right text-[13px] leading-tight text-muted-foreground">All day</div>
              {#each shown as day, d (day)}
                <ul class="grid min-w-0 content-start gap-0.5 border-l border-border/60 p-0.5" aria-label="All day on {longDay(day)}">
                  {#each allDay[d] as o (o.key)}
                    <li><button type="button" class="{chip} {tone(o)}" data-testid="calendar-event" onclick={() => onopen(o)}>{label(o)}</button></li>
                  {/each}
                </ul>
              {/each}
            </div>
          {/if}
        </div>
        <div style="{columns}; height: {24 * HOUR_PX}px">
          <div class="relative" aria-hidden="true">
            {#each hours as h, i (h)}
              {#if i > 0}
                <span class="absolute right-1.5 -translate-y-1/2 text-[13px] text-muted-foreground tabular-nums" style="top: {i * HOUR_PX}px">{h}</span>
              {/if}
            {/each}
          </div>
          {#each shown as day (day)}
            <div class="relative min-w-0 border-l border-border/60 {day === today ? 'bg-muted/30' : ''}" role="group" aria-label={longDay(day)} data-testid="calendar-week-day">
              {#each hours as h, i (h)}
                <!-- Out of the tab order (168 of them); the day's "+" starts an event by keyboard. -->
                <button
                  type="button"
                  tabindex="-1"
                  class="absolute inset-x-0 border-t border-border/60 hover:bg-muted/40 focus-visible:outline-none"
                  style="top: {i * HOUR_PX}px; height: {HOUR_PX}px"
                  aria-label="New event on {longDay(day)} at {h}"
                  onclick={() => oncreate(day, h)}
                ></button>
              {/each}
              {#each placeTimed(dayItems(occurrences, day, timeZone).timed, day, timeZone) as p (p.item.key)}
                {@const px = (p.height / 60) * HOUR_PX}
                <button
                  type="button"
                  class="{eventBox} {tone(p.item)}"
                  style="top: {(p.top / 60) * HOUR_PX}px; height: {Math.max(px, 20)}px; left: {(p.column / p.columns) * 100}%; width: calc({100 / p.columns}% - 2px)"
                  data-testid="calendar-event"
                  onclick={() => onopen(p.item)}
                >
                  <span class="block truncate font-medium">{label(p.item)}</span>
                  <span class="block truncate text-muted-foreground {px < 36 ? 'sr-only' : ''}">{span(p.item)}</span>
                </button>
              {/each}
            </div>
          {/each}
        </div>
      </div>
    </section>
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
</div>
