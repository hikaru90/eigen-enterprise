<script lang="ts" module>
  /** The four areas of Excel's PivotTable Fields list. */
  export type PivotArea = 'filters' | 'columns' | 'rows' | 'values'
  /** What the areas hold: the field names in order; values with how they are summarised; filters with the item shown. */
  export type PivotLayout = {
    rows: string[]
    columns: string[]
    filters: Array<{ field: string; selectedItem?: string }>
    values: Array<{ field: string; agg: PivotAgg }>
  }
</script>

<script lang="ts">
  import type { PivotTableInfo } from './pivot'
  import type { PivotAgg } from './pivot-calc'
  import GripVerticalIcon from '@lucide/svelte/icons/grip-vertical'
  import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw'
  import XIcon from '@lucide/svelte/icons/x'
  import { m } from '$lib/paraglide/messages.js'

  /**
   * Excel's PivotTable Fields list for the PivotTable the active cell is in:
   * the source's fields (a check adds one to Rows, or takes it out), and the
   * four areas — Filters, Columns, Rows, Values — that fields are dragged
   * between (or moved with each chip's "move to" list, the keyboard way).
   * Values say how they are summarised; a filter which item it shows. Every
   * change is one `update_pivot` operation (= drive.sheet_pivot_update);
   * Refresh and Delete are refresh_pivot / delete_pivot.
   */
  let {
    pivot,
    editable,
    onchange,
    onrefresh,
    ondelete,
    onclose,
  }: {
    pivot: PivotTableInfo
    editable: boolean
    onchange: (layout: PivotLayout) => void
    onrefresh: () => void
    ondelete: () => void
    onclose: () => void
  } = $props()

  const AGGS: PivotAgg[] = [
    'sum',
    'count',
    'average',
    'max',
    'min',
    'product',
    'countNums',
    'stdDev',
    'var',
  ]
  const aggLabel = (a: PivotAgg): string =>
    ({
      sum: m.drive_sheet_pivot_agg_sum(),
      count: m.drive_sheet_pivot_agg_count(),
      average: m.drive_sheet_pivot_agg_average(),
      max: m.drive_sheet_pivot_agg_max(),
      min: m.drive_sheet_pivot_agg_min(),
      product: m.drive_sheet_pivot_agg_product(),
      countNums: m.drive_sheet_pivot_agg_count_nums(),
      stdDev: m.drive_sheet_pivot_agg_stddev(),
      var: m.drive_sheet_pivot_agg_var(),
    })[a]
  const areaLabel = (a: PivotArea): string =>
    ({
      filters: m.drive_sheet_pivot_area_filters(),
      columns: m.drive_sheet_pivot_area_columns(),
      rows: m.drive_sheet_pivot_area_rows(),
      values: m.drive_sheet_pivot_area_values(),
    })[a]
  const AREAS: PivotArea[] = ['filters', 'columns', 'rows', 'values']

  const layout = $derived<PivotLayout>({
    rows: pivot.rowFields,
    columns: pivot.colFields,
    filters: pivot.pageFields,
    values: pivot.dataFields.map((d) => ({ field: d.field, agg: d.agg })),
  })
  const names = (a: PivotArea): string[] =>
    a === 'filters'
      ? layout.filters.map((f) => f.field)
      : a === 'values'
        ? layout.values.map((v) => v.field)
        : layout[a]
  const used = $derived(new Set(AREAS.flatMap(names)))

  /** The layout with the chip at `index` of `from` (null: a new field) moved to the end of `to` (null: removed). */
  function moved(field: string, from: PivotArea | null, index: number, to: PivotArea | null) {
    const next: PivotLayout = {
      rows: [...layout.rows],
      columns: [...layout.columns],
      filters: [...layout.filters],
      values: [...layout.values],
    }
    if (from) next[from].splice(index, 1)
    // A field is in one of Rows, Columns and Filters at a time (Excel moves it); Values may repeat it.
    if (to && to !== 'values') {
      next.rows = next.rows.filter((f) => f !== field)
      next.columns = next.columns.filter((f) => f !== field)
      next.filters = next.filters.filter((f) => f.field !== field)
    }
    if (to === 'values') next.values.push({ field, agg: 'sum' })
    else if (to === 'filters') next.filters.push({ field })
    else if (to) next[to].push(field)
    return next
  }

  function toggleField(field: string, on: boolean) {
    if (on) return onchange(moved(field, null, -1, 'rows'))
    onchange({
      rows: layout.rows.filter((f) => f !== field),
      columns: layout.columns.filter((f) => f !== field),
      filters: layout.filters.filter((f) => f.field !== field),
      values: layout.values.filter((v) => v.field !== field),
    })
  }

  function setAgg(index: number, agg: PivotAgg) {
    onchange({ ...layout, values: layout.values.map((v, i) => (i === index ? { ...v, agg } : v)) })
  }

  function setFilterItem(index: number, item: string) {
    onchange({
      ...layout,
      filters: layout.filters.map((f, i) =>
        i === index ? (item === '' ? { field: f.field } : { field: f.field, selectedItem: item }) : f,
      ),
    })
  }

  // Drag and drop between the areas (the "move to" list does the same from the keyboard).
  type Drag = { field: string; from: PivotArea | null; index: number }
  let drag = $state<Drag | null>(null)
  let over = $state<PivotArea | null>(null)

  function start(e: DragEvent, d: Drag) {
    drag = d
    e.dataTransfer?.setData('text/plain', d.field)
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  }
  function drop(e: DragEvent, to: PivotArea) {
    e.preventDefault()
    over = null
    const d = drag
    drag = null
    if (!d || !editable) return
    if (d.from === to && to !== 'values') return
    onchange(moved(d.field, d.from, d.index, to))
  }

  const select = 'h-6 min-w-0 rounded border border-input bg-background px-1 text-xs'
</script>

<aside
  class="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-l bg-background p-3 text-sm"
  aria-label={m.drive_sheet_pivot_fields()}
  data-testid="xlsx-pivot-fields"
>
  <div class="flex items-center justify-between gap-2">
    <h2 class="font-medium">{m.drive_sheet_pivot_fields()}</h2>
    <button
      type="button"
      class="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
      onclick={onclose}
      aria-label={m.drive_sheet_pivot_close()}
      title={m.drive_sheet_pivot_close()}><XIcon class="size-4" aria-hidden="true" /></button
    >
  </div>
  <p class="text-xs text-muted-foreground">{pivot.name}</p>
  <ul class="flex flex-col gap-0.5" data-testid="xlsx-pivot-field-list">
    {#each pivot.fields as f (f)}
      <li
        class="flex items-center gap-1.5 rounded px-1 hover:bg-muted"
        draggable={editable}
        ondragstart={(e) => start(e, { field: f, from: null, index: -1 })}
      >
        <input
          type="checkbox"
          class="accent-primary"
          checked={used.has(f)}
          disabled={!editable}
          onchange={(e) => toggleField(f, e.currentTarget.checked)}
          aria-label={f}
          data-testid="xlsx-pivot-field"
          data-field={f}
        />
        <span class="min-w-0 flex-1 truncate">{f}</span>
        {#if editable}
          <select
            class={select}
            value=""
            aria-label={m.drive_sheet_pivot_add_to({ field: f })}
            onchange={(e) => {
              const to = e.currentTarget.value as PivotArea
              e.currentTarget.value = ''
              if (to) onchange(moved(f, null, -1, to))
            }}
            data-testid="xlsx-pivot-add"
            data-field={f}
          >
            <option value="">+</option>
            {#each AREAS as a (a)}<option value={a}>{areaLabel(a)}</option>{/each}
          </select>
        {/if}
      </li>
    {/each}
  </ul>
  <p class="text-xs text-muted-foreground">{m.drive_sheet_pivot_fields_intro()}</p>
  <div class="grid grid-cols-2 gap-2">
    {#each AREAS as area (area)}
      <section
        class="flex min-h-20 flex-col gap-1 rounded-md border p-1.5 {over === area
          ? 'border-primary bg-primary/5'
          : 'border-border'}"
        aria-label={areaLabel(area)}
        ondragover={(e) => {
          if (!editable) return
          e.preventDefault()
          over = area
        }}
        ondragleave={() => (over = over === area ? null : over)}
        ondrop={(e) => drop(e, area)}
        data-testid="xlsx-pivot-area"
        data-area={area}
        role="list"
      >
        <h3 class="text-xs font-medium text-muted-foreground">{areaLabel(area)}</h3>
        {#each names(area) as f, i (`${f}-${i}`)}
          <div
            class="flex flex-col gap-0.5 rounded bg-muted px-1 py-0.5 text-xs"
            draggable={editable}
            ondragstart={(e) => start(e, { field: f, from: area, index: i })}
            role="listitem"
            data-testid="xlsx-pivot-chip"
            data-field={f}
          >
            <div class="flex items-center gap-1">
              {#if editable}<GripVerticalIcon
                  class="size-3 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />{/if}
              <span class="min-w-0 flex-1 truncate" title={f}>{f}</span>
              {#if editable}
                <button
                  type="button"
                  class="inline-flex size-4 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                  onclick={() => onchange(moved(f, area, i, null))}
                  aria-label={m.drive_sheet_pivot_remove({ field: f })}
                  title={m.drive_sheet_pivot_remove({ field: f })}
                  ><XIcon class="size-3" aria-hidden="true" /></button
                >
              {/if}
            </div>
            {#if editable}
              <select
                class={select}
                value={area}
                aria-label={m.drive_sheet_pivot_move({ field: f })}
                onchange={(e) => {
                  const to = e.currentTarget.value as PivotArea
                  if (to !== area) onchange(moved(f, area, i, to))
                }}
                data-testid="xlsx-pivot-move"
              >
                {#each AREAS as a (a)}<option value={a}>{areaLabel(a)}</option>{/each}
              </select>
            {/if}
            {#if area === 'values'}
              <select
                class={select}
                value={layout.values[i]!.agg}
                disabled={!editable}
                aria-label={m.drive_sheet_pivot_agg({ field: f })}
                onchange={(e) => setAgg(i, e.currentTarget.value as PivotAgg)}
                data-testid="xlsx-pivot-agg"
              >
                {#each AGGS as a (a)}<option value={a}>{aggLabel(a)}</option>{/each}
              </select>
            {:else if area === 'filters'}
              <select
                class={select}
                value={layout.filters[i]!.selectedItem ?? ''}
                disabled={!editable}
                aria-label={m.drive_sheet_pivot_filter_item({ field: f })}
                onchange={(e) => setFilterItem(i, e.currentTarget.value)}
                data-testid="xlsx-pivot-filter-item"
              >
                <option value="">{m.drive_sheet_pivot_filter_all()}</option>
                {#each pivot.fieldItems[f] ?? [] as item (item)}<option value={item}>{item}</option
                  >{/each}
              </select>
            {/if}
          </div>
        {/each}
      </section>
    {/each}
  </div>
  {#if editable}
    <div class="flex flex-wrap gap-1.5">
      <button
        type="button"
        class="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs hover:bg-muted"
        onclick={onrefresh}
        data-testid="xlsx-pivot-refresh"
        ><RefreshCwIcon class="size-3.5" aria-hidden="true" />{m.drive_sheet_pivot_refresh()}</button
      >
      <button
        type="button"
        class="inline-flex h-7 items-center rounded-md border px-2 text-xs text-destructive hover:bg-destructive/10"
        onclick={ondelete}
        data-testid="xlsx-pivot-delete">{m.drive_sheet_pivot_delete()}</button
      >
    </div>
  {/if}
</aside>
