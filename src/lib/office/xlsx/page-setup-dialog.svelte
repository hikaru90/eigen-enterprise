<script lang="ts">
  import { untrack } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { m } from '$lib/paraglide/messages.js'
  import { PAPER_SIZES, type PageSetup, type PaperSize } from './print'

  /** Page Setup + PDF Export dialog. */
  let {
    initial,
    editable,
    exporting,
    onsave,
    onexportpdf,
    onclose,
  }: {
    initial: PageSetup
    editable: boolean
    exporting: boolean
    onsave: (patch: {
      orientation: 'portrait' | 'landscape'
      paperSize: PaperSize
      scale: number
      fitToWidth: number | null
      printGridlines: boolean
      printHeadings: boolean
      printArea: string | null
      repeatRows: string | null
      repeatCols: string | null
    }) => void
    onexportpdf: (opts: { scope: 'active' | 'all' }) => void
    onclose: () => void
  } = $props()

  let orientation = $state<'portrait' | 'landscape'>(untrack(() => initial.orientation))
  let paperSize = $state<PaperSize>(untrack(() => initial.paperSize))
  let scale = $state(untrack(() => initial.scale))
  let fitToWidth = $state(untrack(() => initial.fitToWidth === 1))
  let printGridlines = $state(untrack(() => initial.printGridlines))
  let printHeadings = $state(untrack(() => initial.printHeadings))
  let printArea = $state(untrack(() => initial.printArea ?? ''))
  let repeatRows = $state(untrack(() => initial.repeatRows ?? ''))
  let repeatCols = $state(untrack(() => initial.repeatCols ?? ''))
  let pdfScope = $state<'active' | 'all'>('all')

  function currentPatch() {
    return {
      orientation,
      paperSize,
      scale,
      fitToWidth: fitToWidth ? 1 : null,
      printGridlines,
      printHeadings,
      printArea: printArea.trim() || null,
      repeatRows: repeatRows.trim() || null,
      repeatCols: repeatCols.trim() || null,
    }
  }

  const inputCls = 'h-8 w-full rounded-md border border-input bg-background px-2 text-sm'
  const selectCls = 'h-8 w-full rounded-md border border-input bg-background px-2 text-sm'
</script>

<Dialog.Root
  open={true}
  onOpenChange={(open) => {
    if (!open) onclose()
  }}
>
  <Dialog.Content class="max-w-md" data-testid="xlsx-page-setup-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.drive_sheet_page_setup()}</Dialog.Title>
    </Dialog.Header>

    <div class="grid gap-3 text-sm">
      <div class="grid grid-cols-2 gap-3">
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">{m.drive_sheet_page_orientation()}</span>
          <select
            class={selectCls}
            bind:value={orientation}
            disabled={!editable}
            data-testid="xlsx-page-orientation"
          >
            <option value="portrait">{m.drive_sheet_page_portrait()}</option>
            <option value="landscape">{m.drive_sheet_page_landscape()}</option>
          </select>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">{m.drive_sheet_page_paper()}</span>
          <select
            class={selectCls}
            bind:value={paperSize}
            disabled={!editable}
            data-testid="xlsx-page-paper"
          >
            {#each PAPER_SIZES as p (p)}
              <option value={p}>{p.toUpperCase()}</option>
            {/each}
          </select>
        </label>
      </div>

      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">{m.drive_sheet_page_scaling()}</span>
        <select class={selectCls} bind:value={scale} disabled={!editable || fitToWidth}>
          {#each [50, 70, 80, 90, 100, 110, 125, 150] as pct (pct)}
            <option value={pct}>{m.drive_sheet_page_scale_pct({ pct })}</option>
          {/each}
        </select>
      </label>

      <label class="flex items-center gap-2">
        <input
          type="checkbox"
          class="accent-primary"
          bind:checked={fitToWidth}
          disabled={!editable}
          data-testid="xlsx-page-fit-width"
        />
        {m.drive_sheet_page_fit_width()}
      </label>

      <div class="grid grid-cols-2 gap-3">
        <label class="flex items-center gap-2">
          <input
            type="checkbox"
            class="accent-primary"
            bind:checked={printGridlines}
            disabled={!editable}
            data-testid="xlsx-page-print-gridlines"
          />
          {m.drive_sheet_page_print_gridlines()}
        </label>
        <label class="flex items-center gap-2">
          <input
            type="checkbox"
            class="accent-primary"
            bind:checked={printHeadings}
            disabled={!editable}
            data-testid="xlsx-page-print-headings"
          />
          {m.drive_sheet_page_print_headings()}
        </label>
      </div>

      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">{m.drive_sheet_page_print_area()}</span>
        <input
          type="text"
          class={inputCls}
          bind:value={printArea}
          disabled={!editable}
          placeholder="A1:F40"
          data-testid="xlsx-page-print-area"
        />
      </label>

      <div class="grid grid-cols-2 gap-3">
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">{m.drive_sheet_page_repeat_rows()}</span>
          <input
            type="text"
            class={inputCls}
            bind:value={repeatRows}
            disabled={!editable}
            placeholder="1:1"
            data-testid="xlsx-page-repeat-rows"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">{m.drive_sheet_page_repeat_cols()}</span>
          <input
            type="text"
            class={inputCls}
            bind:value={repeatCols}
            disabled={!editable}
            placeholder="A:A"
            data-testid="xlsx-page-repeat-cols"
          />
        </label>
      </div>

      <label class="flex flex-col gap-1 border-t border-border pt-2">
        <span class="text-xs text-muted-foreground">{m.drive_sheet_page_scope()}</span>
        <select class={selectCls} bind:value={pdfScope} data-testid="xlsx-page-pdf-scope">
          <option value="all">{m.drive_sheet_page_scope_all()}</option>
          <option value="active">{m.drive_sheet_page_scope_active()}</option>
        </select>
      </label>
    </div>

    <Dialog.Footer>
      <Button type="button" variant="outline" onclick={onclose}>{m.drive_sheet_cancel()}</Button>
      {#if editable}
        <Button
          type="button"
          variant="outline"
          onclick={() => {
            onsave(currentPatch())
            onclose()
          }}
          data-testid="xlsx-page-save"
        >
          {m.drive_sheet_page_save()}
        </Button>
      {/if}
      <Button
        type="button"
        disabled={exporting}
        onclick={() => {
          if (editable) onsave(currentPatch())
          onexportpdf({ scope: pdfScope })
        }}
        data-testid="xlsx-page-export-pdf"
      >
        {exporting ? m.drive_sheet_exporting_pdf() : m.drive_sheet_export_pdf()}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
