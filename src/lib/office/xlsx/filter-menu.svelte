<script lang="ts">
  import type { ColumnFilter, FilterChoice } from './filter'
  import ArrowDownAZIcon from '@lucide/svelte/icons/arrow-down-a-z'
  import ArrowDownZAIcon from '@lucide/svelte/icons/arrow-down-z-a'
  import { onMount, untrack } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { Button } from '$lib/components/ui/button'
  import { m } from '$lib/paraglide/messages.js'

  /**
   * An AutoFilter column's menu, as Excel's drop-down: sort the filter range
   * by this column, and tick the values to show ((Select all), (Blanks),
   * a search over the list). OK filters (everything ticked clears the
   * column's filter); Clear filter shows the column's rows again. View-only
   * people see the same list without changing it. Esc or a click outside
   * closes it.
   */
  let {
    col,
    choices,
    current,
    at,
    editable,
    onapply,
    onsort,
    onclose,
  }: {
    /** The column's letter. */
    col: string
    choices: FilterChoice[]
    current: ColumnFilter | undefined
    /** Where the drop-down button is on screen. */
    at: DOMRect
    editable: boolean
    /** values null: no filter on the column. */
    onapply: (values: string[] | null, blanks: boolean) => void
    onsort: (descending: boolean) => void
    onclose: () => void
  } = $props()

  const keyOf = (c: FilterChoice) => c.value.toLowerCase()

  let panel = $state<HTMLDivElement | null>(null)
  let search = $state<HTMLInputElement | null>(null)
  let query = $state('')
  let error = $state<string | null>(null)
  /** The ticked values (lowercase; '' is the blanks). */
  const ticked = new SvelteSet<string>(
    untrack(() => {
      const c = current
      const all = choices.map(keyOf)
      if (c?.kind !== 'values') return all
      const keep = c.values.map((v) => v.toLowerCase())
      if (c.blanks) keep.push('')
      return all.filter((k) => keep.includes(k))
    }),
  )

  const shown = $derived(
    query.trim() === ''
      ? choices
      : choices.filter((c) =>
          (c.label || m.drive_sheet_filter_blanks())
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
        ),
  )
  const allTicked = $derived(shown.length > 0 && shown.every((c) => ticked.has(keyOf(c))))
  const someTicked = $derived(shown.some((c) => ticked.has(keyOf(c))))

  /** Below the button, kept inside the window. */
  const pos = $derived.by(() => {
    const w = 288
    const left = Math.max(8, Math.min(at.right - w, window.innerWidth - w - 8))
    const top = Math.min(at.bottom + 4, Math.max(8, window.innerHeight - 420))
    return `left: ${left}px; top: ${top}px; width: ${w}px;`
  })

  onMount(() => {
    search?.focus()
    const outside = (e: PointerEvent) => {
      if (panel && !panel.contains(e.target as Node)) onclose()
    }
    window.addEventListener('pointerdown', outside, true)
    return () => window.removeEventListener('pointerdown', outside, true)
  })

  function toggle(c: FilterChoice, on: boolean) {
    if (on) ticked.add(keyOf(c))
    else ticked.delete(keyOf(c))
    error = null
  }

  function toggleAll(on: boolean) {
    for (const c of shown) toggle(c, on)
  }

  function apply() {
    if (choices.every((c) => ticked.has(keyOf(c)))) {
      onapply(null, false)
      return
    }
    const values = choices.filter((c) => c.value !== '' && ticked.has(keyOf(c))).map((c) => c.value)
    const blanks = ticked.has('')
    if (values.length === 0 && !blanks) {
      error = m.drive_sheet_filter_pick_one()
      return
    }
    onapply(values, blanks)
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onclose()
    }
  }

  const item =
    'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-40'
</script>

<div
  bind:this={panel}
  class="fixed z-50 flex flex-col gap-2 rounded-md border border-border bg-background p-2 text-sm shadow-lg"
  style={pos}
  role="dialog"
  aria-label={m.drive_sheet_filter_menu({ col })}
  tabindex="-1"
  onkeydown={onKeydown}
  data-testid="xlsx-filter-menu"
>
  {#if editable}
    <div class="flex flex-col">
      <button
        type="button"
        class={item}
        onclick={() => onsort(false)}
        data-testid="xlsx-filter-sort-asc"
        ><ArrowDownAZIcon class="size-4 text-muted-foreground" aria-hidden="true" />
        {m.drive_sheet_sort_asc()}</button
      >
      <button
        type="button"
        class={item}
        onclick={() => onsort(true)}
        data-testid="xlsx-filter-sort-desc"
        ><ArrowDownZAIcon class="size-4 text-muted-foreground" aria-hidden="true" />
        {m.drive_sheet_sort_desc()}</button
      >
    </div>
    <span class="h-px bg-border" aria-hidden="true"></span>
  {/if}
  {#if current?.kind === 'other'}
    <p class="px-1 text-xs text-muted-foreground" data-testid="xlsx-filter-kept">
      {m.drive_sheet_filter_kept()}
    </p>
  {/if}
  <input
    bind:this={search}
    bind:value={query}
    type="search"
    class="h-8 rounded-md border border-input bg-background px-2 text-sm"
    placeholder={m.drive_sheet_filter_search()}
    aria-label={m.drive_sheet_filter_search()}
    data-testid="xlsx-filter-search"
  />
  <div class="max-h-60 overflow-y-auto rounded border border-border/60 py-1" role="group">
    {#if shown.length === 0}
      <p class="px-2 py-1 text-xs text-muted-foreground">{m.drive_sheet_filter_none_found()}</p>
    {:else}
      <label class="flex items-center gap-2 px-2 py-0.5">
        <input
          type="checkbox"
          class="accent-primary"
          checked={allTicked}
          indeterminate={!allTicked && someTicked}
          disabled={!editable}
          onchange={(e) => toggleAll(e.currentTarget.checked)}
          data-testid="xlsx-filter-all"
        />
        {m.drive_sheet_filter_select_all()}
      </label>
      {#each shown as c (keyOf(c))}
        <label class="flex items-center gap-2 px-2 py-0.5">
          <input
            type="checkbox"
            class="accent-primary"
            checked={ticked.has(keyOf(c))}
            disabled={!editable}
            onchange={(e) => toggle(c, e.currentTarget.checked)}
            data-testid="xlsx-filter-value"
            data-value={c.value}
          />
          <span class="min-w-0 flex-1 truncate {c.value === '' ? 'text-muted-foreground' : ''}"
            >{c.value === '' ? m.drive_sheet_filter_blanks() : c.label}</span
          >
          <span class="text-xs text-muted-foreground tabular-nums">{c.count}</span>
        </label>
      {/each}
    {/if}
  </div>
  {#if error}<p class="px-1 text-xs text-destructive" role="alert">{error}</p>{/if}
  <div class="flex items-center justify-end gap-1.5">
    {#if editable && current}
      <Button
        size="sm"
        variant="ghost"
        class="mr-auto"
        onclick={() => onapply(null, false)}
        data-testid="xlsx-filter-clear">{m.drive_sheet_filter_clear()}</Button
      >
    {/if}
    <Button size="sm" variant="outline" onclick={onclose} data-testid="xlsx-filter-cancel"
      >{m.drive_sheet_cancel()}</Button
    >
    {#if editable}
      <Button size="sm" onclick={apply} data-testid="xlsx-filter-ok"
        >{m.drive_sheet_filter_apply()}</Button
      >
    {/if}
  </div>
</div>
