<script lang="ts">
  import type { FreeBusyDto, MemberOption } from '../types'
  import { Button } from '$lib/components/ui/button'
  import { localOf } from '../time'
  import { dayItems, longDay } from './layout'

  /**
   * Colleagues' availability side by side (free/busy only): pick people, see
   * per day when they are busy, out of office, or in a company meeting (only
   * a company-visible event shows its title). The picks travel in the address
   * (`?with=`), so the choice is a plain GET form.
   */
  let {
    members,
    selected,
    people,
    days,
    timeZone,
    hidden,
  }: {
    members: readonly MemberOption[]
    selected: readonly string[]
    people: readonly FreeBusyDto[]
    /** The days shown. */
    days: readonly string[]
    timeZone: string
    /** The address' other parameters (view, date), kept on submit. */
    hidden: Readonly<Record<string, string>>
  } = $props()

  const time = (iso: string) => localOf(iso, timeZone).time
</script>

<section class="grid gap-3" aria-labelledby="availability-title" data-testid="availability">
  <div>
    <h2 id="availability-title" class="text-sm font-semibold">Colleagues’ availability</h2>
    <p class="text-xs text-muted-foreground">Busy or out of office — what each person lets colleagues see, nothing more.</p>
  </div>
  {#if members.length === 0}
    <p class="text-xs text-muted-foreground">No colleagues yet.</p>
  {:else}
    <form method="GET" class="grid gap-2" data-testid="availability-form">
      {#each Object.entries(hidden) as [name, value] (name)}<input type="hidden" {name} {value} />{/each}
      <div class="flex flex-wrap gap-x-4 gap-y-1.5">
        {#each members as m (m.id)}
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" name="with" value={m.id} checked={selected.includes(m.id)} />
            {m.name}
          </label>
        {/each}
      </div>
      <div><Button type="submit" variant="outline" size="sm">Show availability</Button></div>
    </form>
  {/if}

  {#each people as person (person.memberId)}
    <article class="rounded-md border border-border p-2" data-testid="availability-person" aria-label={person.name}>
      <h3 class="mb-1 text-sm font-medium">{person.name}</h3>
      <ul class="grid gap-1">
        {#each days as day (day)}
          {@const items = dayItems(person.blocks, day, timeZone)}
          {@const blocks = [...items.allDay, ...items.timed]}
          <li class="flex flex-wrap items-baseline gap-x-2 text-xs">
            {#if days.length > 1}<span class="w-28 shrink-0 text-muted-foreground">{longDay(day).split(',')[0]} {Number(day.slice(8))}</span>{/if}
            {#if blocks.length === 0}
              <span class="text-muted-foreground">Free</span>
            {:else}
              {#each blocks as b, i (i)}
                <span class="rounded px-1.5 py-0.5 {b.kind === 'out_of_office' ? 'bg-muted text-foreground' : 'bg-primary/15'}" data-testid="availability-block">
                  {items.allDay.includes(b) ? 'All day' : `${time(b.start)}–${time(b.end)}`}
                  · {b.kind === 'out_of_office' ? 'Out of office' : (b.title ?? 'Busy')}
                </span>
              {/each}
            {/if}
          </li>
        {/each}
      </ul>
    </article>
  {/each}
</section>
