<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- every href is built with resolve() or is a server-given path root / API path */
  import ArchiveIcon from '@lucide/svelte/icons/archive'
  import ArchiveRestoreIcon from '@lucide/svelte/icons/archive-restore'
  import DownloadIcon from '@lucide/svelte/icons/download'
  import FileIcon from '@lucide/svelte/icons/file'
  import FileTextIcon from '@lucide/svelte/icons/file-text'
  import FolderIcon from '@lucide/svelte/icons/folder'
  import ImageIcon from '@lucide/svelte/icons/image'
  import SheetIcon from '@lucide/svelte/icons/sheet'
  import SparklesIcon from '@lucide/svelte/icons/sparkles'
  import { invalidateAll } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { Button } from '$lib/components/ui/button'
  import { driveApi, formatSize, type ArchiveGroup, type DriveItem } from '$lib/drive/api'
  import { driveItemKind, shortWhen, type DriveItemKind } from '$lib/drive/display'
  import ArchiveSuggestions from './archive-suggestions.svelte'

  /**
   * The Archived view: archived files and folders, grouped by the folder
   * each one is in (archiving moves nothing), with when and by whom it was
   * archived. Every item still opens; Unarchive (for those who may edit)
   * brings it back into the normal view. "Suggest what to archive" asks the
   * AI for candidates the person then confirms.
   */
  let {
    groups,
    suggestDays,
  }: {
    groups: ArchiveGroup[]
    /** The suggestion cut-off offered first (the server's default). */
    suggestDays: number
  } = $props()

  type Row = ArchiveGroup['items'][number]

  let error = $state<string | null>(null)
  let notice = $state<string | null>(null)
  let busy = $state(false)
  let suggesting = $state(false)

  const placeOf = (g: ArchiveGroup) => g.folder?.name ?? g.path[g.path.length - 1]?.name ?? g.root.label
  const openHref = (item: DriveItem) =>
    item.type === 'folder' ? resolve(`/drive/folder/${item.id}`) : resolve(`/drive/file/${item.id}`)
  const fullWhen = (d: string | Date) =>
    new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

  async function unarchive(group: ArchiveGroup, item: Row) {
    error = null
    notice = null
    busy = true
    try {
      const out = await driveApi.unarchive(item)
      notice = out.stillIn
        ? `“${item.name}” is unarchived. “${out.stillIn.name}”, the folder it is in, is still archived.`
        : `“${item.name}” is back in ${placeOf(group)}.`
      await invalidateAll()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  const ICONS: Record<DriveItemKind, typeof FileIcon> = {
    folder: FolderIcon,
    document: FileTextIcon,
    table: SheetIcon,
    image: ImageIcon,
    pdf: FileTextIcon,
    file: FileIcon,
  }
  const btn =
    'inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50'
</script>

<section class="flex min-h-0 flex-1 flex-col" data-testid="drive-archived" aria-label="Archived">
  <header
    class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 sm:px-6"
  >
    <h2 class="min-w-0 flex-1 text-base font-semibold">Archived</h2>
    <Button
      size="sm"
      variant="outline"
      class="h-8 gap-1.5"
      onclick={() => (suggesting = true)}
      aria-expanded={suggesting}
      data-testid="drive-suggest-archive"
    >
      <SparklesIcon class="size-4" aria-hidden="true" /> Suggest what to archive
    </Button>
  </header>

  <div class="flex flex-col gap-3 px-4 pt-3 sm:px-6">
    <p class="text-sm text-muted-foreground" data-testid="drive-note">
      Archived files and folders stay where they are: they still open, show up in search and keep
      their sharing — they just leave the everyday view. Unarchive brings one back.
    </p>
    {#if error}
      <p
        class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        role="alert"
        data-testid="drive-error"
      >
        {error}
      </p>
    {/if}
    {#if notice}
      <p
        class="rounded-md border px-3 py-2 text-sm text-muted-foreground"
        role="status"
        data-testid="drive-notice"
      >
        {notice}
      </p>
    {/if}
    {#if suggesting}
      <ArchiveSuggestions
        days={suggestDays}
        onclose={() => (suggesting = false)}
        ondone={(message) => {
          notice = message
          suggesting = false
        }}
      />
    {/if}
  </div>

  <div class="min-h-0 flex-1 overflow-auto px-2 pb-10 sm:px-4">
    {#if groups.length === 0}
      <div
        class="flex flex-col items-center gap-3 px-4 py-20 text-center"
        data-testid="drive-empty"
      >
        <div class="flex size-14 items-center justify-center rounded-2xl bg-muted">
          <ArchiveIcon class="size-6 text-muted-foreground" aria-hidden="true" />
        </div>
        <p class="text-sm font-medium">Nothing is archived.</p>
        <p class="max-w-sm text-sm text-muted-foreground">
          Archive files you don’t need day to day but want to keep — from any folder, or let the AI
          suggest old files you might be done with.
        </p>
      </div>
    {:else}
      {#each groups as group (group.key)}
        <section class="pt-4" data-testid="drive-archive-group">
          <h3
            class="flex flex-wrap items-center px-3 pb-1 text-sm font-medium"
            data-testid="drive-archive-group-title"
          >
            <a href={group.root.href} class="text-muted-foreground hover:text-foreground"
              >{group.root.label}</a
            >
            {#each group.path as crumb (crumb.id)}
              <span class="text-muted-foreground" aria-hidden="true">&nbsp;/&nbsp;</span>
              <a
                href={resolve(`/drive/folder/${crumb.id}`)}
                class={crumb.id === group.folder?.id
                  ? 'text-foreground hover:underline'
                  : 'text-muted-foreground hover:text-foreground'}>{crumb.name}</a
              >
            {/each}
          </h3>
          <table class="w-full table-fixed text-sm">
            <thead class="text-left text-xs text-muted-foreground">
              <tr class="border-b border-border">
                <th class="px-3 py-2 font-medium">Name</th>
                <th class="hidden w-32 px-3 py-2 font-medium sm:table-cell">Modified</th>
                <th class="hidden w-52 px-3 py-2 font-medium md:table-cell">Archived</th>
                <th class="hidden w-24 px-3 py-2 font-medium lg:table-cell">Size</th>
                <th class="w-24 px-3 py-2"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {#each group.items as item (item.type + item.id)}
                {@const Icon = ICONS[driveItemKind(item)]}
                <tr
                  class="border-b border-border/60 last:border-0 hover:bg-muted/50"
                  data-testid="drive-archive-row"
                  data-name={item.name}
                >
                  <td class="px-3 py-2">
                    <span class="flex min-w-0 items-center gap-2.5">
                      <Icon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <a class="truncate font-medium hover:underline" href={openHref(item)}
                        >{item.name}</a
                      >
                    </span>
                  </td>
                  <td class="hidden px-3 py-2 text-muted-foreground sm:table-cell">
                    <time datetime={new Date(item.updatedAt).toISOString()} title={fullWhen(item.updatedAt)}
                      >{shortWhen(item.updatedAt)}</time
                    >
                  </td>
                  <td class="hidden px-3 py-2 text-muted-foreground md:table-cell">
                    {#if item.archivedAt}
                      <time
                        datetime={new Date(item.archivedAt).toISOString()}
                        title={fullWhen(item.archivedAt)}>{shortWhen(item.archivedAt)}</time
                      >
                    {/if}
                    {#if item.archivedByName}
                      <span data-testid="drive-archived-by"> · {item.archivedByName}</span>
                    {/if}
                  </td>
                  <td class="hidden px-3 py-2 text-muted-foreground tabular-nums lg:table-cell"
                    >{item.type === 'file' ? formatSize(item.size) : '—'}</td
                  >
                  <td class="px-3 py-1.5 text-right">
                    <span class="inline-flex items-center gap-0.5">
                      {#if item.type === 'file'}
                        <a
                          class={btn}
                          title="Download"
                          aria-label={`Download ${item.name}`}
                          href={`/api/drive/files/${item.id}/content?download=1`}
                          download><DownloadIcon class="size-4" /></a
                        >
                      {/if}
                      {#if item.canEdit}
                        <button
                          class={btn}
                          title="Unarchive"
                          aria-label={`Unarchive ${item.name}`}
                          disabled={busy}
                          data-testid="drive-unarchive"
                          onclick={() => unarchive(group, item)}
                        >
                          <ArchiveRestoreIcon class="size-4" />
                        </button>
                      {/if}
                    </span>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </section>
      {/each}
    {/if}
  </div>
</section>
