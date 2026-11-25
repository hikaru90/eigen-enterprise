<script lang="ts">
  import { untrack } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { m } from '$lib/paraglide/messages.js'

  /**
   * Excel's Create Table (Ctrl+T) and Create PivotTable dialogs: where the
   * data is (prefilled with the block of cells around the active cell), and
   * whether its first row holds headers (a table) or where the PivotTable
   * goes (a new worksheet, or a cell of this sheet). The page runs the
   * operation (`oncreate`).
   */
  let {
    kind,
    range: rangeIn,
    header: headerIn = true,
    at: atIn = '',
    oncreate,
    onclose,
  }: {
    kind: 'table' | 'pivot'
    /** The data's range as text (A1:D20, or Sheet!A1:D20 / a table name for a PivotTable). */
    range: string
    header?: boolean
    /** A PivotTable on this sheet: the default top-left cell. */
    at?: string
    oncreate: (out: { range: string; header: boolean; at: string | null }) => void
    onclose: () => void
  } = $props()

  let range = $state(untrack(() => rangeIn))
  let header = $state(untrack(() => headerIn))
  let where = $state<'new' | 'here'>('new')
  let at = $state(untrack(() => atIn))

  function go() {
    if (range.trim() === '') return
    oncreate({
      range: range.trim(),
      header,
      at: kind === 'pivot' && where === 'here' ? at.trim() || null : null,
    })
  }

  const input = 'h-8 w-full rounded-md border border-input bg-background px-2 font-mono text-sm'
</script>

<Dialog.Root
  open={true}
  onOpenChange={(open) => {
    if (!open) onclose()
  }}
>
  <Dialog.Content class="max-w-md" data-testid="xlsx-{kind}-dialog">
    <Dialog.Header>
      <Dialog.Title
        >{kind === 'table'
          ? m.drive_sheet_table_create_title()
          : m.drive_sheet_pivot_create_title()}</Dialog.Title
      >
    </Dialog.Header>
    <form
      class="flex flex-col gap-3"
      onsubmit={(e) => {
        e.preventDefault()
        go()
      }}
    >
      <label class="flex flex-col gap-1 text-sm">
        {kind === 'table' ? m.drive_sheet_table_range() : m.drive_sheet_pivot_source()}
        <input class={input} bind:value={range} spellcheck="false" data-testid="xlsx-{kind}-range" />
      </label>
      {#if kind === 'table'}
        <label class="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            class="accent-primary"
            bind:checked={header}
            data-testid="xlsx-table-headers"
          />
          {m.drive_sheet_table_has_headers()}
        </label>
      {:else}
        <fieldset class="flex flex-col gap-1.5 text-sm">
          <legend class="mb-1">{m.drive_sheet_pivot_where()}</legend>
          <label class="flex items-center gap-2">
            <input type="radio" class="accent-primary" bind:group={where} value="new" />
            {m.drive_sheet_pivot_new_sheet()}
          </label>
          <label class="flex items-center gap-2">
            <input
              type="radio"
              class="accent-primary"
              bind:group={where}
              value="here"
              data-testid="xlsx-pivot-here"
            />
            {m.drive_sheet_pivot_existing()}
            <input
              class="{input} w-24"
              bind:value={at}
              disabled={where !== 'here'}
              aria-label={m.drive_sheet_pivot_existing()}
              data-testid="xlsx-pivot-at"
            />
          </label>
        </fieldset>
      {/if}
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={onclose}>{m.drive_sheet_cancel()}</Button>
        <Button type="submit" data-testid="xlsx-{kind}-create"
          >{m.drive_sheet_table_create()}</Button
        >
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
