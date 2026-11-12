<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- every href is built with resolve() or comes from the server's path root */
  import ArchiveIcon from '@lucide/svelte/icons/archive'
  import FileIcon from '@lucide/svelte/icons/file'
  import FileTextIcon from '@lucide/svelte/icons/file-text'
  import FolderIcon from '@lucide/svelte/icons/folder'
  import FolderPlusIcon from '@lucide/svelte/icons/folder-plus'
  import ImageIcon from '@lucide/svelte/icons/image'
  import LayoutGridIcon from '@lucide/svelte/icons/layout-grid'
  import ListIcon from '@lucide/svelte/icons/list'
  import PlusIcon from '@lucide/svelte/icons/plus'
  import SearchIcon from '@lucide/svelte/icons/search'
  import SheetIcon from '@lucide/svelte/icons/sheet'
  import UploadIcon from '@lucide/svelte/icons/upload'
  import UsersIcon from '@lucide/svelte/icons/users'
  import { onMount } from 'svelte'
  import { goto, invalidateAll } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { Button } from '$lib/components/ui/button'
  import { driveApi, formatSize, type DriveItem, type ItemDescription } from '$lib/drive/api'
  import { driveItemKind, initialsOf, shortWhen, type DriveItemKind } from '$lib/drive/display'
  import DriveItemActions from './drive-item-actions.svelte'
  import NameDialog from './name-dialog.svelte'

  /**
   * One Drive listing as a full-width app pane (P-3): a toolbar (path, search,
   * New folder, New ▸ Folder / Document / Table, Upload, list ⇄ grid), then
   * the items — a list (icon, name, owner, modified, size, sharing; actions on
   * hover) or a grid (image previews, type icons). Files dropped anywhere on
   * the pane upload here, with an overlay saying where. The server checks
   * every act again; the buttons only hide what the person can't do anyway.
   */
  let {
    folderId,
    path = [],
    items,
    canEdit,
    query = '',
    results = null,
    describe = {},
    emptyText = 'Nothing here yet.',
    emptyHint = null,
    note = null,
    trashView = false,
    showToolbar = true,
    root = { label: 'My drive', href: '/drive' },
  }: {
    folderId: string | null
    path?: Array<{ id: string; name: string }>
    items: DriveItem[]
    canEdit: boolean
    query?: string
    results?: DriveItem[] | null
    /** Owner names and sharing per item, keyed `type:id` (the server's describeItems). */
    describe?: Record<string, ItemDescription>
    emptyText?: string
    /** A second line under the empty state (what to do instead). */
    emptyHint?: string | null
    /** A line under the toolbar (e.g. what Trash does). */
    note?: string | null
    trashView?: boolean
    showToolbar?: boolean
    /** Where the path starts: "My drive", "Shared with me" or "Messages" (from the server). */
    root?: { label: string; href: string }
  } = $props()

  const VIEW_KEY = 'drive-view'
  type View = 'list' | 'grid'

  let error = $state<string | null>(null)
  let notice = $state<string | null>(null)
  let busy = $state(false)
  let dragDepth = $state(0)
  let newMenuOpen = $state(false)
  let nameDialog = $state<{
    title: string
    label: string
    initial: string
    submit: (name: string) => Promise<void>
  } | null>(null)
  let fileInput = $state<HTMLInputElement | null>(null)
  let search = $state(query)
  let view = $state<View>('list')

  const shown = $derived(results ?? items)
  const dropEnabled = $derived(canEdit && !trashView)
  const dragging = $derived(dragDepth > 0)
  const here = $derived(path.length > 0 ? path[path.length - 1]!.name : root.label)

  onMount(() => {
    try {
      const stored = localStorage.getItem(VIEW_KEY)
      if (stored === 'grid' || stored === 'list') view = stored
    } catch {
      // Storage blocked (private window): the list view stays.
    }
  })

  function setView(next: View) {
    view = next
    try {
      localStorage.setItem(VIEW_KEY, next)
    } catch {
      // Storage blocked: the choice lasts for this page only.
    }
  }

  const folderHref = (id: string) => resolve(`/drive/folder/${id}`)
  const fileHref = (id: string) => resolve(`/drive/file/${id}`)
  const openHref = (item: DriveItem) =>
    item.type === 'folder' ? folderHref(item.id) : fileHref(item.id)
  const contentHref = (item: DriveItem) => `/api/drive/files/${item.id}/content`
  const hereHref = () => (folderId ? folderHref(folderId) : resolve('/drive'))

  async function run<T>(act: () => Promise<T>, ok?: string | ((out: T) => string)) {
    error = null
    notice = null
    busy = true
    try {
      const out = await act()
      if (ok) notice = typeof ok === 'function' ? ok(out) : ok
      await invalidateAll()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return
    error = null
    notice = null
    busy = true
    try {
      const out = await driveApi.upload(folderId, files)
      if (out.errors.length > 0) error = out.errors.join(' ')
      if (out.uploaded.length > 0)
        notice = `Uploaded ${out.uploaded.length} file${out.uploaded.length === 1 ? '' : 's'}.`
      await invalidateAll()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  const carriesFiles = (event: DragEvent) =>
    [...(event.dataTransfer?.types ?? [])].includes('Files')

  function onDragEnter(event: DragEvent) {
    if (!dropEnabled || !carriesFiles(event)) return
    event.preventDefault()
    dragDepth += 1
  }
  function onDragOver(event: DragEvent) {
    if (!dropEnabled || !carriesFiles(event)) return
    event.preventDefault()
  }
  function onDragLeave(event: DragEvent) {
    if (!dropEnabled || !carriesFiles(event)) return
    dragDepth = Math.max(0, dragDepth - 1)
  }
  function onDrop(event: DragEvent) {
    event.preventDefault()
    dragDepth = 0
    if (!dropEnabled) return
    void uploadFiles([...(event.dataTransfer?.files ?? [])])
  }

  function newFolder() {
    newMenuOpen = false
    nameDialog = {
      title: 'New folder',
      label: 'Folder name',
      initial: '',
      submit: (name) =>
        run(() => driveApi.createFolder(folderId, name), `Created folder “${name}”.`),
    }
  }
  function newDocument(kind: 'md' | 'csv') {
    newMenuOpen = false
    nameDialog = {
      title: kind === 'md' ? 'New document' : 'New table',
      label: kind === 'md' ? 'Document name (.md)' : 'Table name (.csv)',
      initial: kind === 'md' ? 'Untitled document' : 'Untitled table',
      submit: async (name) => {
        error = null
        try {
          const file = await driveApi.createDocument(folderId, kind, name)
          await goto(fileHref(file.id))
        } catch (err) {
          error = err instanceof Error ? err.message : String(err)
        }
      },
    }
  }

  function submitSearch(event: SubmitEvent) {
    event.preventDefault()
    const q = search.trim()
    void goto(q ? `${hereHref()}?q=${encodeURIComponent(q)}` : hereHref(), { keepFocus: true })
  }

  const ICONS: Record<DriveItemKind, typeof FileIcon> = {
    folder: FolderIcon,
    document: FileTextIcon,
    table: SheetIcon,
    image: ImageIcon,
    pdf: FileTextIcon,
    file: FileIcon,
  }
  /** Kind tiles in the brand palette (docs/brand-palette.md): tinted square, foreground icon. */
  const TILE: Record<DriveItemKind, string> = {
    folder: 'bg-primary/10 text-primary',
    document: 'bg-[#A3D8F4]/45 text-foreground/80',
    table: 'bg-[#B8E9D0]/70 text-foreground/80',
    image: 'bg-[#FE86B1]/30 text-foreground/80',
    pdf: 'bg-[#FF4632]/15 text-foreground/80',
    file: 'bg-muted text-muted-foreground',
  }
  const KIND_LABEL: Record<DriveItemKind, string> = {
    folder: 'Folder',
    document: 'Document',
    table: 'Table',
    image: 'Image',
    pdf: 'PDF',
    file: 'File',
  }

  const descOf = (item: DriveItem): ItemDescription | undefined =>
    describe[`${item.type}:${item.id}`]
  const fullWhen = (d: string | Date) =>
    new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const whenOf = (item: DriveItem) =>
    trashView && item.trashedAt ? item.trashedAt : item.updatedAt
  /** Search results mark what is archived (itself or with its folder); listings never show archived items. */
  const archivedMark = (item: DriveItem) =>
    !trashView && (item.inArchive === true || !!item.archivedAt)
  const toolbarBtn =
    'inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-sm hover:bg-muted disabled:opacity-50'
</script>

<section
  class="relative flex min-h-0 flex-1 flex-col"
  data-testid="drive-browser"
  ondragenter={onDragEnter}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
  aria-label="Files"
>
  <header
    class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 sm:px-6"
    data-testid="drive-toolbar"
  >
    {#if !trashView}
      <nav
        aria-label="Folder path"
        class="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-base"
        data-testid="drive-path"
      >
        <a
          href={root.href}
          class={path.length === 0
            ? 'font-semibold text-foreground'
            : 'text-muted-foreground hover:text-foreground'}
          data-testid="drive-path-root">{root.label}</a
        >
        {#each path as crumb (crumb.id)}
          <span class="text-muted-foreground/60" aria-hidden="true">/</span>
          <a
            href={folderHref(crumb.id)}
            class={crumb.id === folderId
              ? 'font-semibold text-foreground'
              : 'text-muted-foreground hover:text-foreground'}>{crumb.name}</a
          >
        {/each}
      </nav>
    {:else}
      <h2 class="min-w-0 flex-1 text-base font-semibold">Trash</h2>
    {/if}

    {#if showToolbar}
      <form class="relative" onsubmit={submitSearch} role="search">
        <SearchIcon
          class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <input
          class="h-8 w-44 rounded-md border border-input bg-background pr-2 pl-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60 sm:w-60"
          placeholder="Search by name"
          bind:value={search}
          aria-label="Search Drive by name"
          data-testid="drive-search"
        />
      </form>
      {#if canEdit}
        <button
          type="button"
          class={toolbarBtn}
          onclick={newFolder}
          data-testid="drive-new-folder-button"
        >
          <FolderPlusIcon class="size-4" aria-hidden="true" />
          <span class="hidden lg:inline">New folder</span>
        </button>
        <button
          type="button"
          class={toolbarBtn}
          onclick={() => fileInput?.click()}
          disabled={busy}
          data-testid="drive-upload"
        >
          <UploadIcon class="size-4" aria-hidden="true" />
          <span class="hidden lg:inline">Upload</span>
        </button>
        <input
          bind:this={fileInput}
          type="file"
          multiple
          class="hidden"
          data-testid="drive-upload-input"
          onchange={(e) => {
            const input = e.currentTarget as HTMLInputElement
            void uploadFiles([...(input.files ?? [])])
            input.value = ''
          }}
        />
        <div class="relative">
          <Button
            size="sm"
            class="h-8 gap-1"
            onclick={() => (newMenuOpen = !newMenuOpen)}
            aria-expanded={newMenuOpen}
            aria-haspopup="menu"
            data-testid="drive-new"
          >
            <PlusIcon class="size-4" aria-hidden="true" /> New
          </Button>
          {#if newMenuOpen}
            <div
              class="absolute right-0 z-20 mt-1 flex w-52 flex-col rounded-md border bg-popover p-1 text-sm shadow-md"
              role="menu"
              data-testid="drive-new-menu"
            >
              <button
                class="flex items-center gap-2 rounded px-3 py-2 text-left hover:bg-muted"
                role="menuitem"
                onclick={newFolder}
                data-testid="drive-new-folder"
              >
                <FolderIcon class="size-4 text-muted-foreground" aria-hidden="true" /> Folder
              </button>
              <button
                class="flex items-center gap-2 rounded px-3 py-2 text-left hover:bg-muted"
                role="menuitem"
                onclick={() => newDocument('md')}
                data-testid="drive-new-document"
              >
                <FileTextIcon class="size-4 text-muted-foreground" aria-hidden="true" /> Document (.md)
              </button>
              <button
                class="flex items-center gap-2 rounded px-3 py-2 text-left hover:bg-muted"
                role="menuitem"
                onclick={() => newDocument('csv')}
                data-testid="drive-new-table"
              >
                <SheetIcon class="size-4 text-muted-foreground" aria-hidden="true" /> Table (.csv)
              </button>
            </div>
          {/if}
        </div>
      {/if}
    {/if}
    <div
      class="flex items-center rounded-md border border-border p-0.5"
      role="group"
      aria-label="View"
    >
      <button
        type="button"
        class="inline-flex size-7 items-center justify-center rounded {view === 'list'
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground hover:text-foreground'}"
        aria-pressed={view === 'list'}
        aria-label="List view"
        title="List view"
        onclick={() => setView('list')}
        data-testid="drive-view-list"
      >
        <ListIcon class="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="inline-flex size-7 items-center justify-center rounded {view === 'grid'
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground hover:text-foreground'}"
        aria-pressed={view === 'grid'}
        aria-label="Grid view"
        title="Grid view"
        onclick={() => setView('grid')}
        data-testid="drive-view-grid"
      >
        <LayoutGridIcon class="size-4" aria-hidden="true" />
      </button>
    </div>
  </header>

  <div class="flex flex-col gap-2 px-4 pt-3 empty:hidden sm:px-6">
    {#if note}
      <p class="text-sm text-muted-foreground" data-testid="drive-note">{note}</p>
    {/if}
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
    {#if results}
      <p class="text-sm text-muted-foreground" data-testid="drive-search-summary">
        {results.length} result{results.length === 1 ? '' : 's'} for “{query}” ·
        <a href={hereHref()} class="underline-offset-2 hover:underline">clear</a>
      </p>
    {/if}
  </div>

  <div class="min-h-0 flex-1 overflow-auto px-2 pb-10 sm:px-4" data-testid="drive-dropzone">
    {#if shown.length === 0}
      <div
        class="flex flex-col items-center gap-3 px-4 py-20 text-center"
        data-testid="drive-empty"
      >
        <div class="flex size-14 items-center justify-center rounded-2xl bg-muted">
          {#if trashView}
            <FileIcon class="size-6 text-muted-foreground" aria-hidden="true" />
          {:else if root.href === '/drive/shared'}
            <UsersIcon class="size-6 text-muted-foreground" aria-hidden="true" />
          {:else}
            <FolderIcon class="size-6 text-muted-foreground" aria-hidden="true" />
          {/if}
        </div>
        <p class="text-sm font-medium">{results ? 'No file or folder by that name.' : emptyText}</p>
        {#if !results && emptyHint}
          <p class="max-w-sm text-sm text-muted-foreground">{emptyHint}</p>
        {/if}
        {#if !results && dropEnabled}
          <p class="text-sm text-muted-foreground">Drop files here, or</p>
          <div class="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onclick={newFolder}
              data-testid="drive-empty-new-folder"
            >
              <FolderPlusIcon class="size-4" aria-hidden="true" /> New folder
            </Button>
            <Button size="sm" onclick={() => fileInput?.click()} data-testid="drive-empty-upload">
              <UploadIcon class="size-4" aria-hidden="true" /> Upload files
            </Button>
          </div>
        {/if}
      </div>
    {:else if view === 'list'}
      <table class="w-full table-fixed text-sm" data-testid="drive-list">
        <thead class="sticky top-0 z-10 bg-background text-left text-xs text-muted-foreground">
          <tr class="border-b border-border">
            <th class="px-3 py-2 font-medium">Name</th>
            <th class="hidden w-48 px-3 py-2 font-medium lg:table-cell">Owner</th>
            <th class="hidden w-32 px-3 py-2 font-medium sm:table-cell"
              >{trashView ? 'Trashed' : 'Modified'}</th
            >
            <th class="hidden w-24 px-3 py-2 font-medium md:table-cell">Size</th>
            <th class="w-52 px-3 py-2"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {#each shown as item (item.type + item.id)}
            {@const kind = driveItemKind(item)}
            {@const Icon = ICONS[kind]}
            {@const desc = descOf(item)}
            <tr
              class="group border-b border-border/60 last:border-0 hover:bg-muted/50"
              data-testid="drive-row"
              data-name={item.name}
              data-type={item.type}
            >
              <td class="px-3 py-2">
                <span class="flex min-w-0 items-center gap-2.5">
                  <span
                    class="flex size-7 shrink-0 items-center justify-center rounded-md {TILE[kind]}"
                    title={KIND_LABEL[kind]}
                  >
                    <Icon class="size-4" aria-hidden="true" />
                  </span>
                  <span class="sr-only">{KIND_LABEL[kind]}:</span>
                  {#if trashView}
                    <span class="truncate">{item.name}</span>
                  {:else}
                    <a
                      class="truncate font-medium hover:underline"
                      href={openHref(item)}
                      data-testid="drive-open">{item.name}</a
                    >
                  {/if}
                  {#if desc?.shared}
                    <span
                      class="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 py-px text-[10px] text-muted-foreground"
                      title="Shared with others"
                      data-testid="drive-shared-badge"
                    >
                      <UsersIcon class="size-3" aria-hidden="true" /> Shared
                    </span>
                  {/if}
                  {#if archivedMark(item)}
                    <span
                      class="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 py-px text-[10px] text-muted-foreground"
                      title={item.archivedAt ? 'Archived' : 'In an archived folder'}
                      data-testid="drive-archived-badge"
                    >
                      <ArchiveIcon class="size-3" aria-hidden="true" /> Archived
                    </span>
                  {/if}
                </span>
              </td>
              <td class="hidden px-3 py-2 lg:table-cell">
                {#if desc?.ownerName}
                  <span class="flex min-w-0 items-center gap-2" data-testid="drive-owner">
                    <span
                      class="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-foreground/80"
                      aria-hidden="true">{initialsOf(desc.ownerName)}</span
                    >
                    <span class="truncate text-muted-foreground">{desc.ownerName}</span>
                  </span>
                {:else}
                  <span class="text-muted-foreground">—</span>
                {/if}
              </td>
              <td class="hidden px-3 py-2 text-muted-foreground sm:table-cell">
                <time datetime={new Date(whenOf(item)).toISOString()} title={fullWhen(whenOf(item))}
                  >{shortWhen(whenOf(item))}</time
                >
              </td>
              <td class="hidden px-3 py-2 text-muted-foreground tabular-nums md:table-cell"
                >{item.type === 'file' ? formatSize(item.size) : '—'}</td
              >
              <td class="px-3 py-1.5 text-right">
                <span
                  class="inline-flex transition-opacity md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
                >
                  <DriveItemActions {item} {trashView} {run} />
                </span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {:else}
      <ul
        class="grid grid-cols-2 gap-3 pt-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
        data-testid="drive-grid"
      >
        {#each shown as item (item.type + item.id)}
          {@const kind = driveItemKind(item)}
          {@const Icon = ICONS[kind]}
          {@const desc = descOf(item)}
          <li
            class="group relative flex flex-col overflow-hidden rounded-lg border border-border bg-card transition-shadow hover:shadow-md"
            data-testid="drive-row"
            data-name={item.name}
            data-type={item.type}
          >
            <a
              href={trashView ? undefined : openHref(item)}
              class="flex aspect-[4/3] items-center justify-center overflow-hidden {kind ===
                'image' && !trashView
                ? 'bg-muted/40'
                : TILE[kind]}"
              tabindex="-1"
              aria-hidden="true"
            >
              {#if kind === 'image' && !trashView}
                <img
                  src={contentHref(item)}
                  alt=""
                  loading="lazy"
                  class="size-full object-cover"
                  data-testid="drive-thumb"
                />
              {:else}
                <Icon class="size-10 opacity-80" />
              {/if}
            </a>
            <div class="flex min-w-0 items-center gap-2 px-3 py-2">
              <span class="sr-only">{KIND_LABEL[kind]}:</span>
              {#if trashView}
                <span class="truncate text-sm">{item.name}</span>
              {:else}
                <a
                  class="truncate text-sm font-medium hover:underline"
                  href={openHref(item)}
                  data-testid="drive-open">{item.name}</a
                >
              {/if}
              {#if desc?.shared}
                <UsersIcon
                  class="size-3.5 shrink-0 text-muted-foreground"
                  aria-label="Shared with others"
                  data-testid="drive-shared-badge"
                />
              {/if}
              {#if archivedMark(item)}
                <ArchiveIcon
                  class="size-3.5 shrink-0 text-muted-foreground"
                  aria-label="Archived"
                  data-testid="drive-archived-badge"
                />
              {/if}
            </div>
            <div
              class="flex items-center justify-between gap-2 px-3 pb-2 text-xs text-muted-foreground"
            >
              <span class="truncate"
                >{shortWhen(whenOf(item))}{item.type === 'file'
                  ? ` · ${formatSize(item.size)}`
                  : ''}</span
              >
            </div>
            <div
              class="absolute top-1.5 right-1.5 rounded-md bg-background/90 shadow-sm transition-opacity md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
            >
              <DriveItemActions {item} {trashView} {run} />
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  {#if dragging}
    <div
      class="pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-primary/5 backdrop-blur-[1px]"
      data-testid="drive-drop-overlay"
    >
      <UploadIcon class="size-8 text-primary" aria-hidden="true" />
      <p class="text-sm font-medium">Drop to upload to {here}</p>
    </div>
  {/if}
</section>

{#if nameDialog}
  <NameDialog {...nameDialog} onclose={() => (nameDialog = null)} />
{/if}
