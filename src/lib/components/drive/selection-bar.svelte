<script lang="ts">
  import ArchiveIcon from '@lucide/svelte/icons/archive'
  import ArchiveRestoreIcon from '@lucide/svelte/icons/archive-restore'
  import FolderInputIcon from '@lucide/svelte/icons/folder-input'
  import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw'
  import Share2Icon from '@lucide/svelte/icons/share-2'
  import TrashIcon from '@lucide/svelte/icons/trash'
  import XIcon from '@lucide/svelte/icons/x'
  import type { DriveItem } from '$lib/drive/api'
  import { BULK_LABEL, confirmDeleteText, type BulkRequest } from '$lib/drive/bulk'
  import type { BulkAction, HeaderState } from '$lib/drive/selection'
  import { m } from '$lib/paraglide/messages.js'
  import MoveDialog from './move-dialog.svelte'
  import ShareManyDialog from './share-many-dialog.svelte'

  /**
   * The bar over a Drive list while rows are selected: how many, a checkbox
   * for the whole page, the acts valid for every selected item (the caller
   * decides which: `actions`), and Clear. Move and Share ask where / with
   * whom first; Delete forever asks for confirmation (count, can't be undone).
   */
  let {
    items,
    actions,
    page,
    busy = false,
    ontoggleall,
    onclear,
    onrun,
  }: {
    items: DriveItem[]
    actions: BulkAction[]
    /** The header checkbox's state over the current page. */
    page: HeaderState
    busy?: boolean
    ontoggleall: () => void
    onclear: () => void
    onrun: (req: BulkRequest) => Promise<void>
  } = $props()

  const ICON: Record<BulkAction, typeof TrashIcon> = {
    move: FolderInputIcon,
    share: Share2Icon,
    archive: ArchiveIcon,
    unarchive: ArchiveRestoreIcon,
    trash: TrashIcon,
    restore: RotateCcwIcon,
    delete_forever: XIcon,
  }

  let moving = $state(false)
  let sharing = $state(false)

  function act(action: BulkAction) {
    if (action === 'move') moving = true
    else if (action === 'share') sharing = true
    else if (action === 'delete_forever') {
      if (confirm(confirmDeleteText(items.length))) void onrun({ action })
    } else void onrun({ action })
  }

  const btn =
    'inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-sm hover:bg-muted disabled:opacity-50'
</script>

<div
  class="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm"
  role="toolbar"
  aria-label={m.drive_selection_toolbar()}
  data-testid="drive-selection-bar"
>
  <input
    type="checkbox"
    class="size-4 shrink-0 accent-primary"
    checked={page === 'all'}
    indeterminate={page === 'some'}
    aria-label={m.drive_select_page()}
    data-testid="drive-selection-page"
    onclick={ontoggleall}
  />
  <span class="font-medium tabular-nums" role="status" data-testid="drive-selection-count"
    >{m.drive_selected_count({ count: items.length })}</span
  >
  <span class="flex flex-wrap items-center gap-1">
    {#each actions as action (action)}
      {@const Icon = ICON[action]}
      <button
        type="button"
        class={btn}
        disabled={busy}
        data-testid="drive-bulk-{action}"
        onclick={() => act(action)}
      >
        <Icon class="size-4" aria-hidden="true" />
        {BULK_LABEL[action]()}
      </button>
    {:else}
      <span class="text-muted-foreground" data-testid="drive-selection-none-valid"
        >{m.drive_selection_none_valid()}</span
      >
    {/each}
  </span>
  <button
    type="button"
    class="ml-auto inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
    aria-label={m.drive_selection_clear()}
    title={m.drive_selection_clear()}
    data-testid="drive-selection-clear"
    onclick={onclear}
  >
    <XIcon class="size-4" aria-hidden="true" />
  </button>
</div>

{#if moving}
  <MoveDialog
    {items}
    submit={(folderId) => onrun({ action: 'move', folderId })}
    onclose={() => (moving = false)}
  />
{/if}
{#if sharing}
  <ShareManyDialog
    count={items.length}
    submit={(grants) => onrun({ action: 'share', grants })}
    onclose={() => (sharing = false)}
  />
{/if}
