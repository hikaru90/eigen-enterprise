<script lang="ts">
  import ArrowDownIcon from '@lucide/svelte/icons/arrow-down'
  import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left'
  import ArrowRightIcon from '@lucide/svelte/icons/arrow-right'
  import ArrowUpIcon from '@lucide/svelte/icons/arrow-up'
  import BetweenHorizontalStartIcon from '@lucide/svelte/icons/between-horizontal-start'
  import BetweenVerticalStartIcon from '@lucide/svelte/icons/between-vertical-start'
  import Trash2Icon from '@lucide/svelte/icons/trash-2'
  import { tick, untrack } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import {
    emptyGrid,
    insertColumn,
    insertRow,
    moveColumn,
    moveRow,
    parseClipboardBlock,
    parseCsv,
    pasteBlock,
    removeColumn,
    removeRow,
    serializeCsv,
    setCell,
    width,
    type Grid,
  } from '$lib/drive/csv-grid'

  /**
   * The CSV grid editor (W-1): row 1 is the header row. Edit cells in place;
   * Enter/Shift-Enter move down/up, Tab/Shift-Tab right/left, arrows move
   * between cells (left/right at the text's edge), Alt-Enter is a line break
   * inside a cell. Pasting a block copied from a spreadsheet (tabs/lines)
   * fills cells from the active one and grows the table. `onchange` gets the
   * file as RFC 4180 CSV.
   */
  let {
    content,
    editable,
    onchange,
  }: { content: string; editable: boolean; onchange?: (csv: string) => void } = $props()

  function initial(text: string): { grid: Grid; error: string | null } {
    try {
      const g = parseCsv(text)
      return { grid: g.length === 0 ? emptyGrid(3) : g, error: null }
    } catch (err) {
      return { grid: [], error: err instanceof Error ? err.message : String(err) }
    }
  }
  const start = initial(untrack(() => content))
  let grid = $state<Grid>(start.grid)
  let error = $state<string | null>(start.error)
  let isEditable = $state(untrack(() => editable))
  let active = $state({ r: 0, c: 0 })
  let tableEl = $state<HTMLTableElement>()

  const cols = $derived(width(grid))
  const letters = (i: number): string =>
    i < 26
      ? String.fromCharCode(65 + i)
      : letters(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26))

  /** Replaces the table (restore, takeover). */
  export function load(text: string) {
    const next = initial(text)
    grid = next.grid
    error = next.error
    active = {
      r: Math.min(active.r, Math.max(grid.length - 1, 0)),
      c: Math.min(active.c, Math.max(width(grid) - 1, 0)),
    }
  }
  export function setEditable(next: boolean) {
    isEditable = next
  }

  function commit(next: Grid, focus?: { r: number; c: number }) {
    grid = next
    if (focus)
      active = {
        r: Math.max(0, Math.min(focus.r, next.length - 1)),
        c: Math.max(0, Math.min(focus.c, width(next) - 1)),
      }
    onchange?.(serializeCsv(next))
    if (focus) void focusCell(active.r, active.c)
  }

  async function focusCell(r: number, c: number) {
    active = { r, c }
    await tick()
    const el = tableEl?.querySelector<HTMLTextAreaElement>(`[data-r="${r}"][data-c="${c}"]`)
    el?.focus()
    el?.select()
  }

  function move(dr: number, dc: number) {
    const r = Math.max(0, Math.min(active.r + dr, grid.length - 1))
    const c = Math.max(0, Math.min(active.c + dc, cols - 1))
    void focusCell(r, c)
  }

  function oninput(r: number, c: number, event: Event) {
    commit(setCell(grid, r, c, (event.currentTarget as HTMLTextAreaElement).value))
  }

  function onkeydown(event: KeyboardEvent) {
    const el = event.currentTarget as HTMLTextAreaElement
    if (event.key === 'Enter' && event.altKey) {
      event.preventDefault()
      const at = el.selectionStart
      const v = el.value.slice(0, at) + '\n' + el.value.slice(el.selectionEnd)
      commit(setCell(grid, active.r, active.c, v))
      void tick().then(() => el.setSelectionRange(at + 1, at + 1))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (!event.shiftKey && active.r === grid.length - 1)
        commit(insertRow(grid, grid.length), { r: active.r + 1, c: active.c })
      else move(event.shiftKey ? -1 : 1, 0)
    } else if (event.key === 'Tab') {
      event.preventDefault()
      move(0, event.shiftKey ? -1 : 1)
    } else if (event.key === 'ArrowUp' && !el.value.slice(0, el.selectionStart).includes('\n')) {
      event.preventDefault()
      move(-1, 0)
    } else if (event.key === 'ArrowDown' && !el.value.slice(el.selectionEnd).includes('\n')) {
      event.preventDefault()
      move(1, 0)
    } else if (event.key === 'ArrowLeft' && el.selectionStart === 0 && el.selectionEnd === 0) {
      event.preventDefault()
      move(0, -1)
    } else if (event.key === 'ArrowRight' && el.selectionStart === el.value.length) {
      event.preventDefault()
      move(0, 1)
    } else if (event.key === 'Escape') el.blur()
  }

  function onpaste(event: ClipboardEvent) {
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (!text.includes('\t') && !/\r?\n./.test(text)) return // one value: the browser pastes it into the cell
    event.preventDefault()
    const block = parseClipboardBlock(text)
    commit(pasteBlock(grid, active.r, active.c, block), {
      r: active.r + block.length - 1,
      c: active.c + width(block) - 1,
    })
  }

  const actions = {
    addRow: () => commit(insertRow(grid, active.r + 1), { r: active.r + 1, c: active.c }),
    addColumn: () =>
      commit(insertColumn(grid, active.c + 1, `Column ${cols + 1}`), {
        r: active.r,
        c: active.c + 1,
      }),
    removeRow: () =>
      commit(
        grid.length <= 1 ? emptyGrid(Math.max(cols, 1)).slice(0, 1) : removeRow(grid, active.r),
        { r: active.r, c: active.c },
      ),
    removeColumn: () =>
      commit(
        cols <= 1 ? [['Column 1'], ...grid.slice(1).map(() => [''])] : removeColumn(grid, active.c),
        { r: active.r, c: active.c },
      ),
    rowUp: () =>
      active.r > 0 &&
      commit(moveRow(grid, active.r, active.r - 1), { r: active.r - 1, c: active.c }),
    rowDown: () =>
      active.r < grid.length - 1 &&
      commit(moveRow(grid, active.r, active.r + 1), { r: active.r + 1, c: active.c }),
    colLeft: () =>
      active.c > 0 &&
      commit(moveColumn(grid, active.c, active.c - 1), { r: active.r, c: active.c - 1 }),
    colRight: () =>
      active.c < cols - 1 &&
      commit(moveColumn(grid, active.c, active.c + 1), { r: active.r, c: active.c + 1 }),
  }
  const toolbar: Array<
    { id: keyof typeof actions; label: string; icon: typeof ArrowUpIcon } | 'sep'
  > = [
    { id: 'addRow', label: 'Add row below', icon: BetweenHorizontalStartIcon },
    { id: 'rowUp', label: 'Move row up', icon: ArrowUpIcon },
    { id: 'rowDown', label: 'Move row down', icon: ArrowDownIcon },
    { id: 'removeRow', label: 'Delete row', icon: Trash2Icon },
    'sep',
    { id: 'addColumn', label: 'Add column right', icon: BetweenVerticalStartIcon },
    { id: 'colLeft', label: 'Move column left', icon: ArrowLeftIcon },
    { id: 'colRight', label: 'Move column right', icon: ArrowRightIcon },
    { id: 'removeColumn', label: 'Delete column', icon: Trash2Icon },
  ]
</script>

{#if error}
  <p class="px-6 py-8 text-sm text-destructive" role="alert" data-testid="drive-csv-error">
    {error} Download the file to fix it.
  </p>
{:else}
  <div class="flex flex-col" data-testid="drive-csv-editor">
    {#if isEditable}
      <div
        class="sticky top-0 z-10 flex flex-wrap items-center gap-1 border-b bg-background/95 px-2 py-1 backdrop-blur"
        role="toolbar"
        aria-label="Table"
        data-testid="drive-csv-toolbar"
      >
        {#each toolbar as t, i (i)}
          {#if t === 'sep'}
            <span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
          {:else}
            {@const Icon = t.icon}
            <Button
              size="sm"
              variant="ghost"
              class="h-8 gap-1.5 px-2"
              title={t.label}
              onmousedown={(e: MouseEvent) => e.preventDefault()}
              onclick={actions[t.id]}
              data-testid={`drive-csv-${t.id}`}
              ><Icon class="size-4" /><span class="hidden text-xs lg:inline">{t.label}</span
              ></Button
            >
          {/if}
        {/each}
        <span class="ml-auto px-2 text-xs text-muted-foreground" data-testid="drive-csv-position"
          >{letters(active.c)}{active.r + 1} · {grid.length} rows × {cols} columns</span
        >
      </div>
    {/if}
    <div class="max-h-[70vh] overflow-auto">
      <table class="border-collapse text-sm" bind:this={tableEl} data-testid="drive-csv">
        <thead>
          <tr>
            <th class="sticky top-0 left-0 z-20 w-10 border-r border-b bg-muted"></th>
            {#each Array.from({ length: cols }, (_, i) => i) as c (c)}
              <th
                class="sticky top-0 z-10 min-w-32 border-r border-b bg-muted px-2 py-1 text-center text-xs font-normal text-muted-foreground {active.c ===
                c
                  ? 'text-foreground'
                  : ''}">{letters(c)}</th
              >
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each grid as row, r (r)}
            <tr data-testid="drive-csv-row" class={r === 0 ? 'font-medium' : ''}>
              <th
                class="sticky left-0 z-10 border-r border-b bg-muted px-2 text-right text-xs font-normal text-muted-foreground {active.r ===
                r
                  ? 'text-foreground'
                  : ''}"
                scope="row">{r + 1}</th
              >
              {#each row as cell, c (c)}
                <td
                  class="border-r border-b p-0 align-top focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-primary {r === 0
                    ? 'bg-muted/40'
                    : ''} {active.r === r && active.c === c
                    ? 'outline-2 -outline-offset-2 outline-primary'
                    : ''}"
                >
                  {#if isEditable}
                    <textarea
                      rows="1"
                      class="block w-full resize-none bg-transparent px-2 py-1.5 outline-none [field-sizing:content]"
                      value={cell}
                      data-r={r}
                      data-c={c}
                      data-testid="drive-csv-cell"
                      aria-label={`${letters(c)}${r + 1}${r === 0 ? ' (header)' : ''}`}
                      onfocus={() => (active = { r, c })}
                      oninput={(e) => oninput(r, c, e)}
                      {onkeydown}
                      {onpaste}></textarea>
                  {:else}
                    <div
                      class="px-2 py-1.5 whitespace-pre-wrap"
                      data-r={r}
                      data-c={c}
                      data-testid="drive-csv-cell"
                    >
                      {cell}
                    </div>
                  {/if}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
{/if}
