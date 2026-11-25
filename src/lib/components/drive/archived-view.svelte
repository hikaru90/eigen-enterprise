<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- every href is built with resolve() or is a server-given path root / API path */
  import ArchiveIcon from '@lucide/svelte/icons/archive'
  import ArchiveRestoreIcon from '@lucide/svelte/icons/archive-restore'
  import DownloadIcon from '@lucide/svelte/icons/download'
  import FileIcon from '@lucide/svelte/icons/file'
  import FileTextIcon from '@lucide/svelte/icons/file-text'
  import FolderIcon from '@lucide/svelte/icons/folder'
  import ImageIcon from '@lucide/svelte/icons/image'
  import PresentationIcon from '@lucide/svelte/icons/presentation'
  import SheetIcon from '@lucide/svelte/icons/sheet'
  import SparklesIcon from '@lucide/svelte/icons/sparkles'
  import { onMount } from 'svelte'
  import { invalidateAll } from '$app/navigation'
  import { resolve } from '$app/paths'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import { driveApi, formatSize, type ArchiveGroup, type DriveItem } from '$lib/drive/api'
  import { bulkOutcome, runBulk, type BulkOutcome, type BulkRequest } from '$lib/drive/bulk'
  import { driveItemKind, shortWhen, type DriveItemKind } from '$lib/drive/display'
  import {
    bulkActions,
    clickSelect,
    headerState,
    selKey,
    toggleAll,
    type Selection,
  } from '$lib/drive/selection'
  import { driveShownError } from '$lib/drive/shown-error'
  import type { ShownError } from '$lib/errors/agent-report'
  import { m } from '$lib/paraglide/messages.js'
  import { nextSort, sortRows, type SortState } from '$lib/table/sort'
  import SortableHead from '$lib/table/sortable-head.svelte'
  import ArchiveSuggestions from './archive-suggestions.svelte'
  import SelectionBar from './selection-bar.svelte'

  /**
   * The Archived view: archived files and folders, grouped by the folder
   * each one is in (archiving moves nothing), with when and by whom it was
   * archived. Every item still opens; Unarchive (for those who may edit)
   * brings it back into the normal view. "Suggest what to archive" asks the
   * AI for candidates the person then confirms. Rows can be selected (across
   * groups, shift-click for a range, Space on a row, Escape clears) and
   * unarchived together; every item that couldn't be is named with why.
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

  let error = $state<ShownError | null>(null)
  let notice = $state<string | null>(null)
  let busy = $state(false)
  type ColKey = 'name' | 'modified' | 'archived' | 'size'
  let sort = $state<SortState<ColKey>>(null)
  const sortBy = (key: ColKey) => (sort = nextSort(sort, key))
  const sortColumns = {
    name: (i: DriveItem) => i.name,
    modified: (i: DriveItem) => new Date(i.updatedAt),
    archived: (i: DriveItem) => (i.archivedAt ? new Date(i.archivedAt) : null),
    size: (i: DriveItem) => (i.type === 'file' ? i.size : null),
  }
  let suggesting = $state(false)
  let listEl = $state<HTMLElement | null>(null)
  // Keyboard selection is the list's, delegated from its rows (Space on a row, Escape anywhere in it).
  onMount(() => listEl?.addEventListener('keydown', onKeydown))
  let selection = $state.raw<Selection>({ keys: new Set(), anchor: null })
  let bulkFailed = $state.raw<BulkOutcome | null>(null)
  /** Every row in the order shown (groups in order, each sorted): what ranges and the bar's checkbox span. */
  const ordered = $derived(groups.flatMap((g) => sortRows(g.items, sort, sortColumns)))
  const orderedKeys = $derived(ordered.map(selKey))
  const selectedItems = $derived(ordered.filter((i) => selection.keys.has(selKey(i))))
  const groupKeys = (g: ArchiveGroup) => g.items.map(selKey)

  function onCheck(event: MouseEvent, item: Row) {
    selection = clickSelect(selection, orderedKeys, selKey(item), event.shiftKey)
  }
  function toggleKeys(keys: string[]) {
    selection = { keys: toggleAll(selection.keys, keys), anchor: selection.anchor }
  }
  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && selection.keys.size > 0) {
      selection = { keys: new Set(), anchor: null }
      return
    }
    if (event.key !== ' ' || !(event.target instanceof Element)) return
    if (event.target.closest('button, input, select, textarea')) return
    const key = event.target.closest('[data-sel-key]')?.getAttribute('data-sel-key')
    if (!key) return
    event.preventDefault()
    selection = clickSelect(selection, orderedKeys, key, event.shiftKey)
  }

  async function runSelected(req: BulkRequest) {
    const items = selectedItems
    const names = new Map(items.map((i) => [selKey(i), i.name]))
    error = null
    notice = null
    bulkFailed = null
    busy = true
    try {
      const out = bulkOutcome(
        req.action,
        await runBulk(req, items),
        (r) => names.get(selKey(r)) ?? r.id,
      )
      notice = out.notice
      bulkFailed = out.failed ? out : null
      selection = { keys: out.stopped ? new Set(names.keys()) : out.failedKeys, anchor: null }
      await invalidateAll()
    } catch (err) {
      error = driveShownError(err)
    } finally {
      busy = false
    }
  }

  const placeOf = (g: ArchiveGroup) =>
    g.folder?.name ?? g.path[g.path.length - 1]?.name ?? g.root.label
  const openHref = (item: DriveItem) =>
    item.type === 'folder' ? resolve(`/drive/folder/${item.id}`) : resolve(`/drive/file/${item.id}`)
  const fullWhen = (d: string | Date) =>
    new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

  async function unarchive(group: ArchiveGroup, item: Row) {
    error = null
    notice = null
    bulkFailed = null
    busy = true
    try {
      const out = await driveApi.unarchive(item)
      notice = out.stillIn
        ? `“${item.name}” is unarchived. “${out.stillIn.name}”, the folder it is in, is still archived.`
        : `“${item.name}” is back in ${placeOf(group)}.`
      await invalidateAll()
    } catch (err) {
      error = driveShownError(err)
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
    word: FileTextIcon,
    slides: PresentationIcon,
    file: FileIcon,
  }
  const btn =
    'inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50'
</script>

<section
  class="flex min-h-0 flex-1 flex-col"
  data-testid="drive-archived"
  aria-label="Archived"
  bind:this={listEl}
>
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
      <ErrorNotice
        class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2"
        testid="drive-error"
        error={error.error}
        agent={error.agent}
        attempted="Unarchiving an item in Drive’s archive"
      />
    {/if}
    {#if bulkFailed?.failed}
      <ErrorNotice
        class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2"
        testid="drive-bulk-failures"
        error={bulkFailed.failed.heading}
        attempted={m.drive_bulk_attempted()}
      >
        {#if bulkFailed.failed.rows.length > 0}
          <ul class="max-h-48 list-disc overflow-y-auto pl-5 text-red-600">
            {#each bulkFailed.failed.rows as row (row.key)}
              <li data-testid="drive-bulk-failure">
                <span class="font-medium">{row.name}</span> — {row.reason}
              </li>
            {/each}
          </ul>
        {/if}
        {#if bulkFailed.stopped}
          <p data-testid="drive-bulk-stopped">{bulkFailed.stopped}</p>
        {/if}
      </ErrorNotice>
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

  {#if selectedItems.length > 0}
    <div class="px-4 pt-2 sm:px-6">
      <SelectionBar
        items={selectedItems}
        actions={bulkActions(selectedItems, 'archived')}
        page={headerState(selection.keys, orderedKeys)}
        {busy}
        ontoggleall={() => toggleKeys(orderedKeys)}
        onclear={() => (selection = { keys: new Set(), anchor: null })}
        onrun={runSelected}
      />
    </div>
  {/if}

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
                <th scope="col" class="w-10 py-2 pr-1 pl-3">
                  <input
                    type="checkbox"
                    class="size-4 align-middle accent-primary"
                    checked={headerState(selection.keys, groupKeys(group)) === 'all'}
                    indeterminate={headerState(selection.keys, groupKeys(group)) === 'some'}
                    aria-label={m.drive_select_page()}
                    data-testid="drive-select-page"
                    onclick={() => toggleKeys(groupKeys(group))}
                  />
                </th>
                <SortableHead
                  label="Name"
                  sortKey="name"
                  {sort}
                  class="px-3 py-2"
                  onsort={sortBy}
                />
                <SortableHead
                  label="Modified"
                  sortKey="modified"
                  {sort}
                  class="hidden w-32 px-3 py-2 sm:table-cell"
                  onsort={sortBy}
                />
                <SortableHead
                  label="Archived"
                  sortKey="archived"
                  {sort}
                  class="hidden w-52 px-3 py-2 md:table-cell"
                  onsort={sortBy}
                />
                <SortableHead
                  label="Size"
                  sortKey="size"
                  {sort}
                  class="hidden w-24 px-3 py-2 lg:table-cell"
                  onsort={sortBy}
                />
                <th class="w-24 px-3 py-2"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {#each sortRows(group.items, sort, sortColumns) as item (item.type + item.id)}
                {@const Icon = ICONS[driveItemKind(item)]}
                {@const picked = selection.keys.has(selKey(item))}
                <tr
                  class="border-b border-border/60 last:border-0 hover:bg-muted/50 {picked
                    ? 'bg-primary/5'
                    : ''}"
                  data-testid="drive-archive-row"
                  data-sel-key={selKey(item)}
                  data-selected={picked ? 'true' : undefined}
                  data-name={item.name}
                >
                  <td class="py-2 pr-1 pl-3">
                    <input
                      type="checkbox"
                      class="size-4 align-middle accent-primary"
                      checked={picked}
                      aria-label={m.drive_select_row({ name: item.name })}
                      data-testid="drive-select"
                      onclick={(e) => onCheck(e, item)}
                    />
                  </td>
                  <td class="px-3 py-2">
                    <span class="flex min-w-0 items-center gap-2.5">
                      <Icon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <a class="truncate font-medium hover:underline" href={openHref(item)}
                        >{item.name}</a
                      >
                    </span>
                  </td>
                  <td class="hidden px-3 py-2 text-muted-foreground sm:table-cell">
                    <time
                      datetime={new Date(item.updatedAt).toISOString()}
                      title={fullWhen(item.updatedAt)}>{shortWhen(item.updatedAt)}</time
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
