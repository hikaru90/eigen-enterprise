<script lang="ts">
  import type { ExcelTable, UpdateTableOp } from './tables'
  import TableIcon from '@lucide/svelte/icons/table'
  import { m } from '$lib/paraglide/messages.js'
  import { rangeName } from './ref'
  import { isBuiltinTableStyle, TABLE_STYLE_PRESETS } from './tables'

  /**
   * Excel's Table Design ribbon for the table the active cell is in: its
   * name, range (Resize), style, the style options (header row, total row,
   * banded rows/columns, first/last column, filter button) and Convert to
   * range. Each change is one `update_table` / `delete_table` operation —
   * the same as drive.sheet_table_update / _delete.
   */
  type Patch = Omit<UpdateTableOp, 'op' | 'sheet' | 'table'>
  let {
    table,
    editable,
    onupdate,
    onconvert,
  }: {
    table: ExcelTable
    editable: boolean
    onupdate: (patch: Patch) => void
    onconvert: () => void
  } = $props()

  const styles = $derived(
    TABLE_STYLE_PRESETS.some((s) => s.id === table.style.name) || !table.style.name
      ? TABLE_STYLE_PRESETS
      : [{ id: table.style.name, label: table.style.name }, ...TABLE_STYLE_PRESETS],
  )

  function commitText(e: Event & { currentTarget: HTMLInputElement }, key: 'name' | 'ref') {
    const v = e.currentTarget.value.trim()
    const cur = key === 'name' ? table.displayName : rangeName(table.ref)
    if (v === '' || v === cur) {
      e.currentTarget.value = cur
      return
    }
    onupdate(key === 'name' ? { name: v } : { ref: v })
  }

  const onEnter = (e: KeyboardEvent) => {
    if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
  }

  type Flag =
    | 'headerRow'
    | 'totalsRow'
    | 'showRowStripes'
    | 'showColumnStripes'
    | 'showFirstColumn'
    | 'showLastColumn'
    | 'autoFilter'
  const flags = $derived<Array<{ key: Flag; label: string; on: boolean }>>([
    { key: 'headerRow', label: m.drive_sheet_table_header_row(), on: table.headerRowCount > 0 },
    { key: 'totalsRow', label: m.drive_sheet_table_total_row(), on: table.totalsRowCount > 0 },
    { key: 'showRowStripes', label: m.drive_sheet_table_banded_rows(), on: table.style.showRowStripes },
    {
      key: 'showColumnStripes',
      label: m.drive_sheet_table_banded_cols(),
      on: table.style.showColumnStripes,
    },
    { key: 'showFirstColumn', label: m.drive_sheet_table_first_col(), on: table.style.showFirstColumn },
    { key: 'showLastColumn', label: m.drive_sheet_table_last_col(), on: table.style.showLastColumn },
    { key: 'autoFilter', label: m.drive_sheet_table_filter_button(), on: table.autoFilter !== null },
  ])

  const field = 'h-7 rounded-md border border-input bg-background px-2 text-sm'
</script>

<div
  class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/30 px-2 py-1 text-xs"
  role="group"
  aria-label={m.drive_sheet_table_bar({ name: table.displayName })}
  data-testid="xlsx-table-bar"
>
  <span class="inline-flex items-center gap-1.5 font-medium text-foreground">
    <TableIcon class="size-3.5" aria-hidden="true" />
    <input
      class="{field} w-32"
      value={table.displayName}
      readonly={!editable}
      aria-label={m.drive_sheet_table_name_label()}
      onchange={(e) => commitText(e, 'name')}
      onkeydown={onEnter}
      data-testid="xlsx-table-name"
    />
  </span>
  <label class="inline-flex items-center gap-1.5 text-muted-foreground">
    {m.drive_sheet_table_resize()}
    <input
      class="{field} w-24 font-mono"
      value={rangeName(table.ref)}
      readonly={!editable}
      aria-label={m.drive_sheet_table_resize_label({ name: table.displayName })}
      onchange={(e) => commitText(e, 'ref')}
      onkeydown={onEnter}
      data-testid="xlsx-table-ref"
    />
  </label>
  <label class="inline-flex items-center gap-1.5 text-muted-foreground">
    {m.drive_sheet_table_style()}
    <select
      class={field}
      value={table.style.name}
      disabled={!editable}
      onchange={(e) => onupdate({ style: e.currentTarget.value })}
      data-testid="xlsx-table-style"
    >
      {#if !table.style.name}<option value="" disabled>—</option>{/if}
      {#each styles as s (s.id)}<option value={s.id} disabled={!isBuiltinTableStyle(s.id) && s.id !== table.style.name}
          >{s.label}</option
        >{/each}
    </select>
  </label>
  {#each flags as f (f.key)}
    <label class="inline-flex items-center gap-1 text-muted-foreground">
      <input
        type="checkbox"
        class="accent-primary"
        checked={f.on}
        disabled={!editable}
        onchange={(e) => onupdate({ [f.key]: e.currentTarget.checked })}
        data-testid="xlsx-table-{f.key}"
      />
      {f.label}
    </label>
  {/each}
  {#if editable}
    <button
      type="button"
      class="ml-auto inline-flex h-7 items-center rounded-md px-2 text-muted-foreground hover:bg-muted hover:text-foreground"
      onclick={onconvert}
      data-testid="xlsx-table-convert">{m.drive_sheet_table_convert()}</button
    >
  {/if}
</div>
