<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- the download href is an API path, not a page */
  import ArchiveIcon from '@lucide/svelte/icons/archive'
  import ArchiveRestoreIcon from '@lucide/svelte/icons/archive-restore'
  import DownloadIcon from '@lucide/svelte/icons/download'
  import FolderInputIcon from '@lucide/svelte/icons/folder-input'
  import PencilIcon from '@lucide/svelte/icons/pencil'
  import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw'
  import Share2Icon from '@lucide/svelte/icons/share-2'
  import TrashIcon from '@lucide/svelte/icons/trash'
  import XIcon from '@lucide/svelte/icons/x'
  import { driveApi, type DriveItem, type Unarchived } from '$lib/drive/api'
  import MoveDialog from './move-dialog.svelte'
  import NameDialog from './name-dialog.svelte'
  import ShareDialog from './share-dialog.svelte'

  /**
   * A row's actions: only what the person may do is offered (the server
   * decides again). Archive for what they may edit; an archived item (in
   * search results) offers Unarchive instead.
   */
  let {
    item,
    trashView = false,
    run,
  }: {
    item: DriveItem & { canEdit?: boolean; canManage?: boolean }
    trashView?: boolean
    run: <T>(act: () => Promise<T>, ok?: string | ((out: T) => string)) => Promise<void>
  } = $props()

  const unarchivedNotice = (out: Unarchived) =>
    out.stillIn
      ? `Unarchived “${item.name}”. “${out.stillIn.name}”, the folder it is in, is still archived.`
      : `Unarchived “${item.name}”.`

  let renaming = $state(false)
  let moving = $state(false)
  let sharing = $state(false)
  const btn = 'inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground'
</script>

<span class="inline-flex items-center gap-0.5" data-testid="drive-actions">
  {#if trashView}
    <button class={btn} title="Restore" aria-label={`Restore ${item.name}`} data-testid="drive-restore" onclick={() => run(() => driveApi.restore(item), `Restored “${item.name}”.`)}>
      <RotateCcwIcon class="size-4" />
    </button>
    {#if item.canManage}
      <button
        class={btn}
        title="Delete forever"
        aria-label={`Delete ${item.name} forever`}
        data-testid="drive-delete-forever"
        onclick={() => {
          if (confirm(`Delete “${item.name}” forever? This can’t be undone.`)) void run(() => driveApi.deleteForever(item), `Deleted “${item.name}” forever.`)
        }}
      >
        <XIcon class="size-4" />
      </button>
    {/if}
  {:else}
    {#if item.type === 'file'}
      <a class={btn} title="Download" aria-label={`Download ${item.name}`} href={`/api/drive/files/${item.id}/content?download=1`} data-testid="drive-download" download>
        <DownloadIcon class="size-4" />
      </a>
    {/if}
    {#if item.canEdit}
      <button class={btn} title="Rename" aria-label={`Rename ${item.name}`} data-testid="drive-rename" onclick={() => (renaming = true)}>
        <PencilIcon class="size-4" />
      </button>
      <button class={btn} title="Move" aria-label={`Move ${item.name}`} data-testid="drive-move" onclick={() => (moving = true)}>
        <FolderInputIcon class="size-4" />
      </button>
    {/if}
    {#if item.canManage}
      <button class={btn} title="Share" aria-label={`Share ${item.name}`} data-testid="drive-share" onclick={() => (sharing = true)}>
        <Share2Icon class="size-4" />
      </button>
    {/if}
    {#if item.canEdit}
      {#if item.archivedAt}
        <button class={btn} title="Unarchive" aria-label={`Unarchive ${item.name}`} data-testid="drive-unarchive" onclick={() => run(() => driveApi.unarchive(item), unarchivedNotice)}>
          <ArchiveRestoreIcon class="size-4" />
        </button>
      {:else}
        <button
          class={btn}
          title="Archive (hide from this view; it stays openable and searchable)"
          aria-label={`Archive ${item.name}`}
          data-testid="drive-archive"
          onclick={() => run(() => driveApi.archive(item), `Archived “${item.name}”. Find it under Archived.`)}
        >
          <ArchiveIcon class="size-4" />
        </button>
      {/if}
      <button class={btn} title="Move to trash" aria-label={`Move ${item.name} to trash`} data-testid="drive-trash" onclick={() => run(() => driveApi.trash(item), `Moved “${item.name}” to the trash.`)}>
        <TrashIcon class="size-4" />
      </button>
    {/if}
  {/if}
</span>

{#if renaming}
  <NameDialog
    title={`Rename ${item.type}`}
    label="New name"
    initial={item.name}
    submit={(name) => run(() => driveApi.rename(item, name), `Renamed to “${name}”.`)}
    onclose={() => (renaming = false)}
  />
{/if}
{#if moving}
  <MoveDialog {item} submit={(folderId) => run(() => driveApi.move(item, folderId), `Moved “${item.name}”.`)} onclose={() => (moving = false)} />
{/if}
{#if sharing}
  <ShareDialog {item} onclose={() => (sharing = false)} />
{/if}
