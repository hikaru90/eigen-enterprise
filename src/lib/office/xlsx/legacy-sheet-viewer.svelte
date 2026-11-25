<script lang="ts">
  import type { OfficeViewerProps } from '../viewers'
  import type { ConversionLoss } from './convert'
  import CopyIcon from '@lucide/svelte/icons/copy'
  import LoaderIcon from '@lucide/svelte/icons/loader-circle'
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import { driveApi } from '$lib/drive/api'
  import { driveShownError } from '$lib/drive/shown-error'
  import type { ShownError } from '$lib/errors/agent-report'
  import { m } from '$lib/paraglide/messages.js'
  import XlsxEditor from './xlsx-editor.svelte'

  /**
   * Excel 97–2003 (.xls) and OpenDocument (.ods) spreadsheets in the Drive:
   * not OOXML, so never edited in place. The file is converted to .xlsx in
   * the browser (./convert.ts, SheetJS loaded only here) and shown in the
   * same grid, read-only. "Make an editable .xlsx copy" saves the converted
   * workbook as a new file next to the original (drive.make_xlsx_copy, on
   * the server) and opens it; what the copy does not keep is listed first.
   */
  let { fileId, name, kind, canEdit, heartbeatMs }: OfficeViewerProps = $props()

  // svelte-ignore state_referenced_locally
  const format = kind
  if (format !== 'xls' && format !== 'ods')
    throw new Error(
      `legacy-sheet-viewer: ${name} is not an .xls or .ods file (kind ${String(kind)}).`,
    )

  const NOT_KEPT: Record<ConversionLoss, () => string> = {
    cell_styles: m.drive_sheet_legacy_loss_cell_styles,
    charts_images: m.drive_sheet_legacy_loss_charts_images,
    conditional_formats: m.drive_sheet_legacy_loss_conditional_formats,
    data_validations: m.drive_sheet_legacy_loss_data_validations,
    pivot_tables: m.drive_sheet_legacy_loss_pivot_tables,
    macros: m.drive_sheet_legacy_loss_macros,
  }

  let notKept = $state<readonly ConversionLoss[]>([])
  let copying = $state(false)
  let failure = $state<ShownError | null>(null)

  async function converted(): Promise<Uint8Array> {
    const [{ convertToXlsx }, bytes] = await Promise.all([
      import('./convert'),
      driveApi.readBytes(fileId),
    ])
    const out = await convertToXlsx(format as 'xls' | 'ods', bytes)
    notKept = out.notKept
    return out.bytes
  }

  async function makeCopy() {
    copying = true
    failure = null
    try {
      const out = await driveApi.makeXlsxCopy(fileId)
      await goto(resolve(`/drive/file/${out.file.id}`))
    } catch (err) {
      failure = driveShownError(err)
    } finally {
      copying = false
    }
  }
</script>

<div class="flex min-h-0 flex-1 flex-col" data-testid="legacy-sheet" data-format={format}>
  <div class="space-y-2 border-b bg-muted/40 px-3 py-2 text-sm" data-testid="legacy-sheet-banner">
    <p>
      {m.drive_sheet_legacy_banner({
        format:
          format === 'xls' ? m.drive_sheet_legacy_format_xls() : m.drive_sheet_legacy_format_ods(),
      })}
    </p>
    {#if notKept.length > 0}
      <div class="text-xs text-muted-foreground">
        <p>{m.drive_sheet_legacy_not_kept()}</p>
        <ul class="mt-1 list-disc pl-5" data-testid="legacy-sheet-not-kept">
          {#each notKept as loss (loss)}<li>{NOT_KEPT[loss]()}</li>{/each}
        </ul>
      </div>
    {/if}
    {#if canEdit}
      <Button
        size="sm"
        disabled={copying}
        onclick={() => void makeCopy()}
        data-testid="legacy-sheet-copy"
      >
        {#if copying}
          <LoaderIcon class="size-4 animate-spin" aria-hidden="true" />
          {m.drive_sheet_legacy_copying()}
        {:else}
          <CopyIcon class="size-4" aria-hidden="true" />
          {m.drive_sheet_legacy_copy()}
        {/if}
      </Button>
    {/if}
    {#if failure}
      <ErrorNotice
        testid="legacy-sheet-failure"
        error={failure.error}
        agent={failure.agent}
        attempted={m.drive_sheet_legacy_attempt({ name })}
      />
    {/if}
  </div>
  <XlsxEditor {fileId} {name} canEdit={false} {heartbeatMs} source={converted} />
</div>
