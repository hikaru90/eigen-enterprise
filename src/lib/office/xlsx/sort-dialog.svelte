<script lang="ts">
  import type { SortKey } from './sort'
  import MinusIcon from '@lucide/svelte/icons/minus'
  import PlusIcon from '@lucide/svelte/icons/plus'
  import { untrack } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { m } from '$lib/paraglide/messages.js'
  import { colName, rangeName, type Range } from './ref'

  /**
   * Excel's Sort dialog: the range, whether its first row is a header, and
   * the sort levels (a column and an order each; the first decides, the next
   * break ties). The page runs the sort (`onsort`).
   */
  let {
    range,
    header: headerIn,
    first,
    headerText,
    onsort,
    onclose,
  }: {
    range: Range
    header: boolean
    /** The column the first level starts with. */
    first: number
    /** The header cell's text of a column ('' when none). */
    headerText: (col: number) => string
    onsort: (keys: SortKey[], header: boolean) => void
    onclose: () => void
  } = $props()

  let header = $state(untrack(() => headerIn))
  let levels = $state<Array<{ id: number; col: number; descending: boolean }>>([
    { id: 0, col: untrack(() => first), descending: false },
  ])
  let nextId = 1

  const columns = $derived(
    Array.from({ length: range.right - range.left + 1 }, (_, i) => range.left + i),
  )
  const label = (c: number) => {
    const name = header ? headerText(c) : ''
    return name
      ? m.drive_sheet_sort_column_named({ col: colName(c), name })
      : m.drive_sheet_sort_column({ col: colName(c) })
  }

  function addLevel() {
    const used = new Set(levels.map((l) => l.col))
    const col = columns.find((c) => !used.has(c)) ?? range.left
    levels = [...levels, { id: nextId++, col, descending: false }]
  }

  function go() {
    onsort(
      levels.map((l) => ({ col: l.col, descending: l.descending })),
      header,
    )
  }

  const select = 'h-8 min-w-0 rounded-md border border-input bg-background px-2 text-sm'
</script>

<Dialog.Root
  open={true}
  onOpenChange={(open) => {
    if (!open) onclose()
  }}
>
  <Dialog.Content class="max-w-lg" data-testid="xlsx-sort-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.drive_sheet_sort_title({ range: rangeName(range) })}</Dialog.Title>
      <Dialog.Description>{m.drive_sheet_sort_intro()}</Dialog.Description>
    </Dialog.Header>
    <label class="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        class="accent-primary"
        bind:checked={header}
        data-testid="xlsx-sort-header"
      />
      {m.drive_sheet_sort_header()}
    </label>
    <ol class="flex flex-col gap-2">
      {#each levels as level, i (level.id)}
        <li class="flex items-center gap-2 text-sm">
          <span class="w-24 shrink-0 text-muted-foreground"
            >{i === 0 ? m.drive_sheet_sort_by() : m.drive_sheet_sort_then_by()}</span
          >
          <select
            class="{select} flex-1"
            aria-label={i === 0 ? m.drive_sheet_sort_by() : m.drive_sheet_sort_then_by()}
            bind:value={level.col}
            data-testid="xlsx-sort-column"
          >
            {#each columns as c (c)}<option value={c}>{label(c)}</option>{/each}
          </select>
          <select
            class={select}
            aria-label={m.drive_sheet_sort_order()}
            bind:value={level.descending}
            data-testid="xlsx-sort-order"
          >
            <option value={false}>{m.drive_sheet_sort_order_asc()}</option>
            <option value={true}>{m.drive_sheet_sort_order_desc()}</option>
          </select>
          <button
            type="button"
            class="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            disabled={levels.length === 1}
            onclick={() => (levels = levels.filter((l) => l.id !== level.id))}
            aria-label={m.drive_sheet_sort_remove_level()}
            title={m.drive_sheet_sort_remove_level()}
            ><MinusIcon class="size-4" aria-hidden="true" /></button
          >
        </li>
      {/each}
    </ol>
    <div>
      <Button
        size="sm"
        variant="ghost"
        onclick={addLevel}
        disabled={levels.length >= Math.min(64, columns.length)}
        data-testid="xlsx-sort-add"
        ><PlusIcon class="size-4" aria-hidden="true" />
        {m.drive_sheet_sort_add_level()}</Button
      >
    </div>
    <Dialog.Footer>
      <Button variant="outline" onclick={onclose}>{m.drive_sheet_cancel()}</Button>
      <Button onclick={go} data-testid="xlsx-sort-go">{m.drive_sheet_sort_go()}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
