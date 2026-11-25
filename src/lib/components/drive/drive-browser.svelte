<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- every href is built with resolve() or comes from the server's path root */
  import ArchiveIcon from '@lucide/svelte/icons/archive'
  import FileIcon from '@lucide/svelte/icons/file'
  import FileTextIcon from '@lucide/svelte/icons/file-text'
  import FolderIcon from '@lucide/svelte/icons/folder'
  import FolderLockIcon from '@lucide/svelte/icons/folder-lock'
  import FolderPlusIcon from '@lucide/svelte/icons/folder-plus'
  import FolderUpIcon from '@lucide/svelte/icons/folder-up'
  import HardDriveIcon from '@lucide/svelte/icons/hard-drive'
  import ImageIcon from '@lucide/svelte/icons/image'
  import LayoutGridIcon from '@lucide/svelte/icons/layout-grid'
  import ListIcon from '@lucide/svelte/icons/list'
  import LockIcon from '@lucide/svelte/icons/lock'
  import MessageSquareIcon from '@lucide/svelte/icons/message-square'
  import PlusIcon from '@lucide/svelte/icons/plus'
  import PresentationIcon from '@lucide/svelte/icons/presentation'
  import SearchIcon from '@lucide/svelte/icons/search'
  import SheetIcon from '@lucide/svelte/icons/sheet'
  import UploadIcon from '@lucide/svelte/icons/upload'
  import UsersIcon from '@lucide/svelte/icons/users'
  import { onMount } from 'svelte'
  import { goto, invalidateAll } from '$app/navigation'
  import { resolve } from '$app/paths'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import {
    driveApi,
    formatSize,
    type DriveItem,
    type DriveOrigin,
    type ItemDescription,
  } from '$lib/drive/api'
  import {
    datedLabel,
    driveItemKind,
    hasThumbnail,
    textPreviewOf,
    initialsOf,
    shortWhen,
    type DriveItemKind,
  } from '$lib/drive/display'
  import { driveShownError } from '$lib/drive/shown-error'
  import {
    collectDropped,
    droppedSources,
    entriesFromPicked,
    planUpload,
    runUpload,
    type ConflictDecision,
    type UploadConflict,
    type UploadFailure,
    type UploadPlan,
    type UploadProgress,
  } from '$lib/drive/upload'
  import type { ShownError } from '$lib/errors/agent-report'
  import { nextSort, sortRows, type SortState } from '$lib/table/sort'
  import SortableHead from '$lib/table/sortable-head.svelte'
  import DriveItemActions from './drive-item-actions.svelte'
  import DriveTextPreview from './drive-text-preview.svelte'
  import NameDialog from './name-dialog.svelte'
  import UploadConflictDialog from './upload-conflict-dialog.svelte'

  /**
   * One Drive listing as a full-width app pane (P-3): a toolbar (path, search,
   * New folder, New ▸ Folder / Document / Table, Upload, list ⇄ grid), then
   * the items — a list (icon, name, owner, modified, size, sharing; actions on
   * hover) or a grid (image previews, type icons). Files and folders dropped
   * from the desktop upload here — or into the folder row they are dropped on
   * — with an overlay saying where; "Upload folder" picks a whole folder. A
   * folder's tree is recreated, then its files go up one by one with
   * progress, and every file that didn't land is listed with why. Items the
   * person may edit can be dragged onto a folder row to move them there.
   * Drop targets are whatever folder rows are rendered now (looked up from
   * the drop's own element), so a folder created in this view takes drops at
   * once. The server checks every act again; the buttons only hide what the
   * person can't do anyway.
   */
  let {
    folderId,
    path = [],
    items,
    canEdit,
    origin = null,
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
    items: Listed[]
    canEdit: boolean
    /** Initial origin filter selected via URL (e.g. `?origin=mine` on `/drive`). */
    origin?: string | null
    query?: string
    results?: Listed[] | null
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
  /** Large source folders stay responsive: render one page, not thousands of rows. */
  const PAGE_SIZE = 200
  type View = 'list' | 'grid'
  type Listed = DriveItem & {
    canEdit?: boolean
    canManage?: boolean
    origin?: DriveOrigin
    originLabel?: string
  }
  type KindFilter = 'all' | 'folder' | 'file'
  const KIND_FILTERS: ReadonlyArray<{ id: KindFilter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'folder', label: 'Folders' },
    { id: 'file', label: 'Files' },
  ]
  /** The type a Drive row's drag carries (moves within Drive, never an upload). */
  const ITEM_DRAG = 'application/x-ee-drive-item'

  let error = $state<ShownError | null>(null)
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
  let folderInput = $state<HTMLInputElement | null>(null)
  /** The Drive row being dragged (a move), while it is. */
  let draggedItem = $state<Listed | null>(null)
  /** The folder row under the current drag, when it takes the drop. */
  let dropFolder = $state<Listed | null>(null)
  let progress = $state<UploadProgress | null>(null)
  /** An upload's name clash waiting for the person's answer (the upload pauses until then). */
  let clash = $state<{ conflict: UploadConflict; answer: (d: ConflictDecision) => void } | null>(
    null,
  )
  let failures = $state<UploadFailure[]>([])
  let search = $state(query)
  let view = $state<View>('list')
  /** The page asked for, and the listing it was asked for in: new results (or a new folder) start at page 1. */
  let paging = $state.raw<{ of: Listed[] | null; page: number }>({ of: null, page: 1 })
  /** User-selected origin pill tied to the `origin` prop it was chosen under (resets when `origin` changes). */
  let pickedOrigin = $state.raw<{ forProp: string | null; value: string } | null>(null)
  let kindFilter = $state<KindFilter>('all')

  const hasOverviewOrigins = $derived(
    !trashView && !results && items.some((i) => i.origin !== undefined),
  )
  const sourceLabels = $derived(
    [
      ...new Set(
        items.filter((i) => i.origin === 'source' && i.originLabel).map((i) => i.originLabel!),
      ),
    ].sort((a, b) => a.localeCompare(b)),
  )
  function normalizeOrigin(raw: string | null): string {
    if (raw === 'mine' || raw === 'shared' || raw === 'messages' || raw === 'source') return raw
    if (raw?.startsWith('source:') && sourceLabels.includes(raw.slice('source:'.length))) return raw
    return 'all'
  }
  const activeOrigin = $derived(
    pickedOrigin !== null && pickedOrigin.forProp === origin
      ? pickedOrigin.value
      : normalizeOrigin(origin),
  )
  const matchesOrigin = (item: Listed, selected: string) => {
    if (selected === 'all') return true
    if (selected.startsWith('source:')) {
      return item.origin === 'source' && item.originLabel === selected.slice('source:'.length)
    }
    return item.origin === selected
  }
  const slugify = (label: string) =>
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'item'
  const originPills = $derived.by(() => {
    if (!hasOverviewOrigins) return []
    const countFor = (key: string) => items.filter((i) => matchesOrigin(i, key)).length
    const pills: Array<{
      key: string
      label: string
      kind: DriveOrigin | 'all'
      count: number
      testid: string
    }> = [
      { key: 'all', label: 'All', kind: 'all', count: items.length, testid: 'drive-filter-all' },
      {
        key: 'mine',
        label: 'My drive',
        kind: 'mine',
        count: countFor('mine'),
        testid: 'drive-filter-mine',
      },
      {
        key: 'shared',
        label: 'Shared with me',
        kind: 'shared',
        count: countFor('shared'),
        testid: 'drive-filter-shared',
      },
      {
        key: 'messages',
        label: 'Messages',
        kind: 'messages',
        count: countFor('messages'),
        testid: 'drive-filter-messages',
      },
    ]
    for (const label of sourceLabels) {
      pills.push({
        key: `source:${label}`,
        label,
        kind: 'source',
        count: countFor(`source:${label}`),
        testid: `drive-filter-source-${slugify(label)}`,
      })
    }
    return pills
  })
  const filteredItems = $derived.by(() => {
    if (!hasOverviewOrigins) return items
    return items.filter(
      (item) =>
        matchesOrigin(item, activeOrigin) && (kindFilter === 'all' || item.type === kindFilter),
    )
  })
  type ColKey = 'name' | 'owner' | 'when' | 'from' | 'size'
  let sort = $state<SortState<ColKey>>(null)
  const sortColumns = {
    name: (i: Listed) => i.name,
    owner: (i: Listed) => describe[`${i.type}:${i.id}`]?.ownerName,
    when: (i: Listed) => new Date(whenOf(i)),
    from: (i: Listed) => (i.dated ? new Date(i.dated.at) : null),
    size: (i: Listed) => (i.type === 'file' ? i.size : null),
  }
  const unsorted = $derived(results ?? filteredItems)
  const shown = $derived(sortRows(unsorted, sort, sortColumns))
  const isFiltered = $derived(
    hasOverviewOrigins && (activeOrigin !== 'all' || kindFilter !== 'all'),
  )
  const pageCount = $derived(Math.max(1, Math.ceil(shown.length / PAGE_SIZE)))
  const requestedPage = $derived(paging.of === shown ? paging.page : 1)
  const currentPage = $derived(Math.min(requestedPage, pageCount))
  const firstShown = $derived((currentPage - 1) * PAGE_SIZE)
  const visible = $derived(shown.slice(firstShown, firstShown + PAGE_SIZE))
  const sortBy = (key: ColKey) => (sort = nextSort(sort, key))
  const dropEnabled = $derived(canEdit && !trashView)
  const dragging = $derived(dragDepth > 0)
  const dropDestination = $derived(
    dropFolder
      ? dropFolder.name
      : path.length > 0
        ? path[path.length - 1]!.name
        : hasOverviewOrigins || root.label === 'Overview'
          ? 'My drive'
          : root.label,
  )
  /** A folder row that takes drops: one the person may edit, never the item being dragged itself. */
  const takesDrops = (item: Listed) =>
    dropEnabled && item.type === 'folder' && item.canEdit === true && item.id !== draggedItem?.id
  const draggable = (item: Listed) => !trashView && item.canEdit === true

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

  function previousPage() {
    paging = { of: shown, page: Math.max(1, currentPage - 1) }
  }

  function nextPage() {
    paging = { of: shown, page: Math.min(pageCount, currentPage + 1) }
  }

  function selectOrigin(next: string) {
    pickedOrigin = { forProp: origin, value: next }
    paging = { of: null, page: 1 }
  }

  function selectKind(next: KindFilter) {
    kindFilter = next
    paging = { of: null, page: 1 }
  }

  function resetFilters() {
    pickedOrigin = { forProp: origin, value: 'all' }
    kindFilter = 'all'
    paging = { of: null, page: 1 }
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
    failures = []
    busy = true
    try {
      const out = await act()
      if (ok) notice = typeof ok === 'function' ? ok(out) : ok
      await invalidateAll()
    } catch (err) {
      error = driveShownError(err)
    } finally {
      busy = false
    }
  }

  /** Asks about one name clash; the upload waits for the answer. */
  function askConflict(conflict: UploadConflict): Promise<ConflictDecision> {
    return new Promise((done) => {
      clash = {
        conflict,
        answer: (d) => {
          clash = null
          done(d)
        },
      }
    })
  }

  /** Uploads a plan into `target` (null: the current view), then says what landed and lists what didn't. */
  async function upload(plan: UploadPlan, target: Listed | null) {
    if (plan.files.length === 0 && plan.folders.length === 0 && plan.failures.length === 0) return
    error = null
    notice = null
    failures = []
    busy = true
    progress = { done: 0, total: plan.files.length, current: '' }
    try {
      const out = await runUpload(
        plan,
        target ? target.id : folderId,
        driveApi,
        askConflict,
        (p) => (progress = p),
      )
      failures = out.failures
      if (out.stopped) error = { error: `The upload stopped: ${out.stopped}`, agent: null }
      const landed: string[] = []
      if (out.uploaded > 0) landed.push(`${out.uploaded} file${out.uploaded === 1 ? '' : 's'}`)
      if (out.folders > 0)
        landed.push(
          `${out.uploaded > 0 ? 'in ' : ''}${out.folders} folder${out.folders === 1 ? '' : 's'}`,
        )
      const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`
      const said: string[] = []
      if (landed.length > 0)
        said.push(`Uploaded ${landed.join(' ')}${target ? ` to ${target.name}` : ''}.`)
      if (out.replaced > 0)
        said.push(
          `Replaced ${files(out.replaced)} with a new version (the old one stays in its history).`,
        )
      if (out.skipped.length > 0)
        said.push(
          `Left out ${files(out.skipped.length)} that ${out.skipped.length === 1 ? 'is' : 'are'} already there.`,
        )
      if (said.length > 0) notice = said.join(' ')
      await invalidateAll()
    } catch (err) {
      error = driveShownError(err)
    } finally {
      busy = false
      progress = null
    }
  }

  function uploadPicked(input: HTMLInputElement) {
    const plan = planUpload(entriesFromPicked([...(input.files ?? [])]))
    input.value = ''
    void upload(plan, null)
  }

  const carriesFiles = (event: DragEvent) =>
    [...(event.dataTransfer?.types ?? [])].includes('Files')
  /** The folder row this drag event is over, when that row takes drops. */
  function folderUnder(event: DragEvent): Listed | null {
    const el = event.target instanceof Element ? event.target.closest('[data-drop-folder]') : null
    const id = el?.getAttribute('data-drop-folder')
    const folder = id ? shown.find((i) => i.type === 'folder' && i.id === id) : undefined
    return folder && takesDrops(folder) ? folder : null
  }

  function onDragEnter(event: DragEvent) {
    if (!dropEnabled) return
    if (draggedItem) {
      dropFolder = folderUnder(event)
      if (dropFolder) event.preventDefault()
      return
    }
    if (!carriesFiles(event)) return
    event.preventDefault()
    dragDepth += 1
    dropFolder = folderUnder(event)
  }
  function onDragOver(event: DragEvent) {
    if (!dropEnabled) return
    if (draggedItem) {
      dropFolder = folderUnder(event)
      // Only a folder row takes a move; anywhere else the drop isn't offered.
      if (dropFolder) {
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
      }
      return
    }
    if (!carriesFiles(event)) return
    event.preventDefault()
    dropFolder = folderUnder(event)
  }
  function onDragLeave(event: DragEvent) {
    if (!dropEnabled || draggedItem || !carriesFiles(event)) return
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) dropFolder = null
  }
  function onDrop(event: DragEvent) {
    event.preventDefault()
    const target = dropEnabled ? folderUnder(event) : null
    dragDepth = 0
    dropFolder = null
    if (!dropEnabled) return
    const moved = draggedItem
    if (moved) {
      draggedItem = null
      if (target)
        void run(() => driveApi.move(moved, target.id), `Moved “${moved.name}” to ${target.name}.`)
      return
    }
    if (!event.dataTransfer || !carriesFiles(event)) return
    if (busy) {
      error = { error: 'Wait for the current upload to finish, then drop again.', agent: null }
      return
    }
    // Read the items now: the browser empties them once this handler returns.
    const sources = droppedSources(event.dataTransfer)
    void collectDropped(sources).then(
      (plan) => upload(plan, target),
      (err: unknown) =>
        (error = {
          error: `Couldn’t read what was dropped: ${err instanceof Error ? err.message : String(err)}`,
          agent: null,
        }),
    )
  }

  function onRowDragStart(event: DragEvent, item: Listed) {
    if (!event.dataTransfer) return
    draggedItem = item
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(ITEM_DRAG, `${item.type}:${item.id}`)
  }
  function onRowDragEnd() {
    draggedItem = null
    dropFolder = null
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
          error = driveShownError(err)
        }
      },
    }
  }

  function submitSearch(event: SubmitEvent) {
    event.preventDefault()
    paging = { of: null, page: 1 }
    const q = search.trim()
    void goto(q ? `${hereHref()}?q=${encodeURIComponent(q)}` : hereHref(), { keepFocus: true })
  }

  const ICONS: Record<DriveItemKind, typeof FileIcon> = {
    folder: FolderIcon,
    document: FileTextIcon,
    table: SheetIcon,
    image: ImageIcon,
    pdf: FileTextIcon,
    word: FileTextIcon,
    slides: PresentationIcon,
    sheet: SheetIcon,
    file: FileIcon,
  }
  /** Kind tiles in the brand palette (docs/brand-palette.md): tinted square, foreground icon. */
  const TILE: Record<DriveItemKind, string> = {
    folder: 'bg-primary/10 text-primary',
    document: 'bg-[#A3D8F4]/45 text-foreground/80 dark:bg-[#A3D8F4]/20',
    table: 'bg-[#B8E9D0]/70 text-foreground/80 dark:bg-[#B8E9D0]/20',
    image: 'bg-[#FE86B1]/30 text-foreground/80 dark:bg-[#FE86B1]/20',
    pdf: 'bg-[#FF4632]/15 text-foreground/80 dark:bg-[#FF4632]/20',
    word: 'bg-[#A3D8F4]/45 text-foreground/80 dark:bg-[#A3D8F4]/20',
    slides: 'bg-[#FFC107]/25 text-foreground/80 dark:bg-[#FFC107]/20',
    sheet: 'bg-[#B8E9D0]/70 text-foreground/80 dark:bg-[#B8E9D0]/20',
    file: 'bg-muted text-muted-foreground',
  }
  /** Brand CI color-coded origin styles (docs/brand-palette.md), contrast-safe in light and dark modes. */
  const ORIGIN_STYLE: Record<
    DriveOrigin,
    {
      badge: string
      tile: string
      tileRing: string
      pillActive: string
      dot: string
      icon: typeof HardDriveIcon
      fallbackLabel: string
    }
  > = {
    mine: {
      badge: 'bg-primary/12 text-primary border-primary/25',
      tile: 'bg-primary/12 text-primary ring-1 ring-inset ring-primary/20',
      tileRing: 'ring-1 ring-inset ring-primary/25',
      pillActive: 'border-primary bg-primary text-primary-foreground',
      dot: 'bg-primary',
      icon: HardDriveIcon,
      fallbackLabel: 'My drive',
    },
    shared: {
      badge:
        'bg-[#A3D8F4]/40 text-[#0B4F71] border-[#0062E6]/25 dark:bg-[#A3D8F4]/18 dark:text-[#A3D8F4] dark:border-[#A3D8F4]/35',
      tile: 'bg-[#A3D8F4]/45 text-[#0B4F71] dark:bg-[#A3D8F4]/20 dark:text-[#A3D8F4]',
      tileRing: 'ring-1 ring-inset ring-[#0062E6]/35 dark:ring-[#A3D8F4]/40',
      pillActive:
        'border-[#0062E6]/45 bg-[#A3D8F4]/55 text-[#0B4F71] dark:border-[#A3D8F4]/50 dark:bg-[#A3D8F4]/25 dark:text-[#A3D8F4]',
      dot: 'bg-[#0062E6] dark:bg-[#A3D8F4]',
      icon: UsersIcon,
      fallbackLabel: 'Shared with me',
    },
    messages: {
      badge:
        'bg-[#B8E9D0]/55 text-[#005A24] border-[#007E33]/25 dark:bg-[#B8E9D0]/16 dark:text-[#B8E9D0] dark:border-[#B8E9D0]/35',
      tile: 'bg-[#B8E9D0]/60 text-[#005A24] dark:bg-[#B8E9D0]/20 dark:text-[#B8E9D0]',
      tileRing: 'ring-1 ring-inset ring-[#007E33]/35 dark:ring-[#B8E9D0]/40',
      pillActive:
        'border-[#007E33]/45 bg-[#B8E9D0]/70 text-[#005A24] dark:border-[#B8E9D0]/50 dark:bg-[#B8E9D0]/25 dark:text-[#B8E9D0]',
      dot: 'bg-[#007E33] dark:bg-[#B8E9D0]',
      icon: MessageSquareIcon,
      fallbackLabel: 'Messages',
    },
    source: {
      badge:
        'bg-[#FFC107]/25 text-[#7A3200] border-[#FF4632]/30 dark:bg-[#FFC107]/16 dark:text-[#FFD65C] dark:border-[#FF4632]/40',
      tile: 'bg-[#FFC107]/25 text-[#7A3200] dark:bg-[#FFC107]/20 dark:text-[#FFD65C]',
      tileRing: 'ring-1 ring-inset ring-[#FF4632]/35 dark:ring-[#FFD65C]/40',
      pillActive:
        'border-[#FF4632]/45 bg-[#FFC107]/35 text-[#7A3200] dark:border-[#FF4632]/50 dark:bg-[#FFC107]/25 dark:text-[#FFD65C]',
      dot: 'bg-[#FF4632] dark:bg-[#FFD65C]',
      icon: FolderLockIcon,
      fallbackLabel: 'Source',
    },
  }
  function tileClass(item: Listed, kind: DriveItemKind): string {
    if (!item.origin) return TILE[kind]
    const style = ORIGIN_STYLE[item.origin]
    return kind === 'folder' ? style.tile : `${TILE[kind]} ${style.tileRing}`
  }
  const KIND_LABEL: Record<DriveItemKind, string> = {
    folder: 'Folder',
    document: 'Document',
    table: 'Table',
    image: 'Image',
    pdf: 'PDF',
    word: 'Word',
    slides: 'Slides',
    sheet: 'Spreadsheet',
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

{#snippet dated(d: NonNullable<DriveItem['dated']>)}
  {@const label = datedLabel(d)}
  <span class="whitespace-nowrap" title={label.full} data-testid="drive-dated"
    ><time datetime={new Date(d.at).toISOString()}>{label.month}</time>
    <span class="text-xs text-muted-foreground">{label.kind}</span></span
  >
{/snippet}

{#snippet dropBadge(item: Listed)}
  <span
    class="inline-flex shrink-0 items-center rounded-full bg-primary px-1.5 py-px text-xs font-medium text-primary-foreground"
    data-testid="drive-drop-target"
    data-name={item.name}>{draggedItem ? 'Move here' : 'Upload here'}</span
  >
{/snippet}

{#snippet originBadge(item: Listed)}
  {#if item.origin}
    {@const style = ORIGIN_STYLE[item.origin]}
    {@const OriginIcon = style.icon}
    {@const label = item.originLabel ?? style.fallbackLabel}
    <span
      class="inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-xs font-medium {style.badge}"
      data-testid="drive-origin-badge"
      data-origin={item.origin}
    >
      <OriginIcon class="size-3 shrink-0" aria-hidden="true" />
      {label}
    </span>
  {/if}
{/snippet}

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
          <span class="text-muted-foreground" aria-hidden="true">/</span>
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
          class="h-8 w-44 rounded-md border border-input bg-background pr-2 pl-8 text-sm outline-none focus-visible:ring-2 -ring sm:w-60"
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
          onchange={(e) => uploadPicked(e.currentTarget)}
        />
        <button
          type="button"
          class={toolbarBtn}
          onclick={() => folderInput?.click()}
          disabled={busy}
          title="Upload a folder with everything in it"
          data-testid="drive-upload-folder"
        >
          <FolderUpIcon class="size-4" aria-hidden="true" />
          <span class="sr-only lg:not-sr-only">Upload folder</span>
        </button>
        <input
          bind:this={folderInput}
          type="file"
          webkitdirectory
          class="hidden"
          data-testid="drive-upload-folder-input"
          onchange={(e) => uploadPicked(e.currentTarget)}
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

  {#if hasOverviewOrigins}
    <div
      class="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/15 px-4 py-2.5 sm:px-6"
      data-testid="drive-filter-bar"
    >
      <div
        class="flex flex-wrap items-center gap-1.5"
        role="group"
        aria-label="Filter by origin"
        data-testid="drive-origin-filters"
      >
        {#each originPills as pill (pill.key)}
          {@const active = activeOrigin === pill.key}
          <button
            type="button"
            class="inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors {active
              ? pill.kind === 'all'
                ? 'border-primary bg-primary text-primary-foreground'
                : ORIGIN_STYLE[pill.kind].pillActive
              : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'}"
            aria-pressed={active}
            data-testid={pill.testid}
            data-origin={pill.kind === 'all' ? undefined : pill.kind}
            onclick={() => selectOrigin(pill.key)}
          >
            {#if pill.kind !== 'all'}
              <span
                class="size-2 shrink-0 rounded-full {active
                  ? 'bg-current'
                  : ORIGIN_STYLE[pill.kind].dot}"
                aria-hidden="true"
              ></span>
            {/if}
            <span>{pill.label}</span>
            <span class="tabular-nums opacity-75">{pill.count}</span>
          </button>
        {/each}
      </div>
      <div class="flex items-center gap-2">
        <div
          class="flex items-center rounded-full border border-border bg-background p-0.5"
          role="group"
          aria-label="Filter by type"
          data-testid="drive-type-filter"
        >
          {#each KIND_FILTERS as kindOpt (kindOpt.id)}
            <button
              type="button"
              class="rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors {kindFilter ===
              kindOpt.id
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:text-foreground'}"
              aria-pressed={kindFilter === kindOpt.id}
              data-testid="drive-type-{kindOpt.id}"
              onclick={() => selectKind(kindOpt.id)}
            >
              {kindOpt.label}
            </button>
          {/each}
        </div>
        <span class="text-xs text-muted-foreground tabular-nums" data-testid="drive-visible-count">
          {isFiltered ? `${shown.length} of ${items.length}` : shown.length} item{(isFiltered
            ? items.length
            : shown.length) === 1
            ? ''
            : 's'}
        </span>
      </div>
    </div>
  {/if}

  <div class="flex flex-col gap-2 px-4 pt-3 empty:hidden sm:px-6">
    {#if note}
      <p class="text-sm text-muted-foreground" data-testid="drive-note">{note}</p>
    {/if}
    {#if error}
      <ErrorNotice
        class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2"
        testid="drive-error"
        error={error.error}
        agent={error.agent}
        attempted={`Working in Drive (${folderId ? `folder ${folderId}` : 'the top of the drive'})`}
      />
    {/if}
    {#if progress}
      <div
        class="flex flex-col gap-1.5 rounded-md border px-3 py-2 text-sm"
        role="status"
        data-testid="drive-upload-progress"
      >
        <p class="truncate">
          Uploading {Math.min(progress.done + 1, progress.total)} of {progress.total} file{progress.total ===
          1
            ? ''
            : 's'}{progress.current ? ` · ${progress.current}` : ''}
        </p>
        <progress
          class="h-1.5 w-full accent-primary"
          max={Math.max(progress.total, 1)}
          value={progress.done}
        >
          {progress.done} of {progress.total}
        </progress>
      </div>
    {/if}
    {#if failures.length > 0}
      <ErrorNotice
        class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2"
        testid="drive-upload-failures"
        error={`${failures.length === 1 ? '1 item wasn’t' : `${failures.length} items weren’t`} uploaded:`}
        attempted={`Uploading files to Drive (${folderId ? `folder ${folderId}` : 'the top of the drive'}); each item below says why it was refused`}
      >
        <ul class="max-h-48 list-disc overflow-y-auto pl-5 text-red-600">
          {#each failures as failure, i (i)}
            <li data-testid="drive-upload-failure">
              <span class="font-medium">{failure.path}</span> — {failure.reason}
            </li>
          {/each}
        </ul>
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
        <p class="text-sm font-medium">
          {#if results}
            No file or folder by that name.
          {:else if isFiltered && items.length > 0}
            {activeOrigin === 'mine' && kindFilter === 'all'
              ? 'Nothing in My drive yet.'
              : 'No items match this filter.'}
          {:else}
            {emptyText}
          {/if}
        </p>
        {#if !results && isFiltered && items.length > 0}
          <Button
            size="sm"
            variant="outline"
            onclick={resetFilters}
            data-testid="drive-filter-reset"
          >
            Show all
          </Button>
        {:else if !results && emptyHint}
          <p class="max-w-sm text-sm text-muted-foreground">{emptyHint}</p>
        {/if}
        {#if !results && dropEnabled && (!isFiltered || activeOrigin === 'mine')}
          <p class="text-sm text-muted-foreground">Drop files or folders here, or</p>
          <div class="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onclick={newFolder}
              data-testid="drive-empty-new-folder"
            >
              <FolderPlusIcon class="size-4" aria-hidden="true" /> New folder
            </Button>
            <Button
              size="sm"
              onclick={() => fileInput?.click()}
              disabled={busy}
              data-testid="drive-empty-upload"
            >
              <UploadIcon class="size-4" aria-hidden="true" /> Upload files
            </Button>
            <Button
              size="sm"
              variant="outline"
              onclick={() => folderInput?.click()}
              disabled={busy}
              data-testid="drive-empty-upload-folder"
            >
              <FolderUpIcon class="size-4" aria-hidden="true" /> Upload folder
            </Button>
          </div>
        {/if}
      </div>
    {:else if view === 'list'}
      <!-- Optional columns follow the list's own width (container queries), not the window's:
           beside the nav and the Drive sections a 1280px window leaves ~800px, and fixed
           columns sized for the window squeezed the name to nothing. The name keeps ≥ ~14rem. -->
      <div class="@container">
        <table class="w-full table-fixed text-sm" data-testid="drive-list">
          <thead class="sticky top-0 z-10 bg-background text-left text-xs text-muted-foreground">
            <tr class="border-b border-border">
              <SortableHead label="Name" sortKey="name" {sort} class="px-3 py-2" onsort={sortBy} />
              <SortableHead
                label="Owner"
                sortKey="owner"
                {sort}
                class="hidden w-48 px-3 py-2 @5xl:table-cell"
                onsort={sortBy}
              />
              <SortableHead
                label={trashView ? 'Trashed' : 'Modified'}
                sortKey="when"
                {sort}
                class="hidden w-32 px-3 py-2 @xl:table-cell"
                onsort={sortBy}
              />
              <SortableHead
                label="From"
                sortKey="from"
                {sort}
                class="hidden w-36 px-3 py-2 @4xl:table-cell"
                onsort={sortBy}
              />
              <SortableHead
                label="Size"
                sortKey="size"
                {sort}
                class="hidden w-24 px-3 py-2 @2xl:table-cell"
                onsort={sortBy}
              />
              <th class="w-52 px-3 py-2"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {#each visible as item (item.type + item.id)}
              {@const kind = driveItemKind(item)}
              {@const Icon = ICONS[kind]}
              {@const thumb = hasThumbnail(item) && !trashView}
              {@const desc = descOf(item)}
              <tr
                class="group border-b border-border/60 last:border-0 hover:bg-muted/50 {dropFolder?.id ===
                item.id
                  ? 'bg-primary/10 outline-2 -outline-offset-2 outline-primary'
                  : ''}"
                data-testid="drive-row"
                data-name={item.name}
                data-type={item.type}
                data-origin={item.origin}
                data-drop-folder={takesDrops(item) ? item.id : undefined}
                draggable={draggable(item) ? 'true' : undefined}
                ondragstart={(e) => draggable(item) && onRowDragStart(e, item)}
                ondragend={onRowDragEnd}
              >
                <td class="px-3 py-2">
                  <span class="flex min-w-0 items-center gap-2.5">
                    <span
                      class="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md {thumb
                        ? 'bg-muted/40'
                        : tileClass(item, kind)}"
                      title={KIND_LABEL[kind]}
                    >
                      {#if thumb}
                        <img
                          src={contentHref(item)}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          class="size-full object-cover"
                          data-testid="drive-list-thumb"
                        />
                      {:else}
                        <Icon class="size-4" aria-hidden="true" />
                      {/if}
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
                    {#if dropFolder?.id === item.id}
                      {@render dropBadge(item)}
                    {/if}
                    {@render originBadge(item)}
                    {#if desc?.readOnlyFrom}
                      <span
                        class="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 py-px text-xs text-muted-foreground"
                        title={`Comes from ${desc.readOnlyFrom}; change it there`}
                        data-testid="drive-readonly-badge"
                      >
                        <LockIcon class="size-3" aria-hidden="true" />
                        {item.origin === 'source' && item.originLabel === desc.readOnlyFrom
                          ? 'Read-only'
                          : `${desc.readOnlyFrom} · read-only`}
                      </span>
                    {/if}
                    {#if desc?.shared}
                      <span
                        class="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 py-px text-xs text-muted-foreground"
                        title="Shared with others"
                        data-testid="drive-shared-badge"
                      >
                        <UsersIcon class="size-3" aria-hidden="true" /> Shared
                      </span>
                    {/if}
                    {#if archivedMark(item)}
                      <span
                        class="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 py-px text-xs text-muted-foreground"
                        title={item.archivedAt ? 'Archived' : 'In an archived folder'}
                        data-testid="drive-archived-badge"
                      >
                        <ArchiveIcon class="size-3" aria-hidden="true" /> Archived
                      </span>
                    {/if}
                  </span>
                </td>
                <td class="hidden px-3 py-2 @5xl:table-cell">
                  {#if desc?.ownerName}
                    <span class="flex min-w-0 items-center gap-2" data-testid="drive-owner">
                      <span
                        class="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground/80"
                        aria-hidden="true">{initialsOf(desc.ownerName)}</span
                      >
                      <span class="truncate text-muted-foreground">{desc.ownerName}</span>
                    </span>
                  {:else}
                    <span class="text-muted-foreground">—</span>
                  {/if}
                </td>
                <td class="hidden px-3 py-2 text-muted-foreground @xl:table-cell">
                  <time
                    datetime={new Date(whenOf(item)).toISOString()}
                    title={fullWhen(whenOf(item))}>{shortWhen(whenOf(item))}</time
                  >
                </td>
                <td class="hidden px-3 py-2 text-muted-foreground @4xl:table-cell">
                  {#if item.dated}
                    {@render dated(item.dated)}
                  {:else}
                    —
                  {/if}
                </td>
                <td class="hidden px-3 py-2 text-muted-foreground tabular-nums @2xl:table-cell"
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
      </div>
    {:else}
      <ul
        class="grid grid-cols-2 gap-3 pt-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
        data-testid="drive-grid"
      >
        {#each visible as item (item.type + item.id)}
          {@const kind = driveItemKind(item)}
          {@const Icon = ICONS[kind]}
          {@const thumb = hasThumbnail(item) && !trashView}
          {@const textPreview = trashView ? null : textPreviewOf(item)}
          {@const desc = descOf(item)}
          <li
            class="group relative flex flex-col overflow-hidden rounded-lg border bg-card transition-shadow hover:shadow-md {dropFolder?.id ===
            item.id
              ? 'border-primary ring-2 ring-primary'
              : 'border-border'}"
            data-testid="drive-row"
            data-name={item.name}
            data-type={item.type}
            data-origin={item.origin}
            data-drop-folder={takesDrops(item) ? item.id : undefined}
            draggable={draggable(item) ? 'true' : undefined}
            ondragstart={(e) => draggable(item) && onRowDragStart(e, item)}
            ondragend={onRowDragEnd}
          >
            <a
              href={trashView ? undefined : openHref(item)}
              class="flex aspect-[4/3] items-center justify-center overflow-hidden {thumb
                ? 'bg-muted/40'
                : textPreview
                  ? 'border-b border-border/60 bg-background'
                  : tileClass(item, kind)}"
              tabindex="-1"
              aria-hidden="true"
            >
              {#if thumb}
                <img
                  src={contentHref(item)}
                  alt=""
                  loading="lazy"
                  class="size-full object-cover"
                  data-testid="drive-thumb"
                />
              {:else if textPreview}
                <DriveTextPreview fileId={item.id} mode={textPreview}>
                  {#snippet fallback()}
                    <Icon class="size-10 opacity-80" />
                  {/snippet}
                </DriveTextPreview>
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
              {#if dropFolder?.id === item.id}
                {@render dropBadge(item)}
              {/if}
              {#if desc?.readOnlyFrom}
                <LockIcon
                  class="size-3.5 shrink-0 text-muted-foreground"
                  aria-label={`${desc.readOnlyFrom} · read-only`}
                  data-testid="drive-readonly-badge"
                />
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
            {#if item.origin}
              <div class="flex flex-wrap items-center gap-1.5 px-3 pb-1.5">
                {@render originBadge(item)}
              </div>
            {/if}
            <div
              class="flex items-center justify-between gap-2 px-3 pb-2 text-xs text-muted-foreground"
            >
              <span class="truncate"
                >{shortWhen(whenOf(item))}{item.type === 'file'
                  ? ` · ${formatSize(item.size)}`
                  : ''}</span
              >
              {#if item.dated}
                <span class="shrink-0">{@render dated(item.dated)}</span>
              {/if}
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

  {#if pageCount > 1}
    <nav
      class="flex flex-wrap items-center justify-center gap-3 border-t border-border px-4 py-2 text-sm"
      aria-label="Drive listing pages"
      data-testid="drive-pages"
    >
      <button
        type="button"
        class="rounded-md border border-border px-2.5 py-1 hover:bg-muted disabled:opacity-50"
        disabled={currentPage === 1}
        onclick={previousPage}
        data-testid="drive-page-previous">Previous</button
      >
      <span class="text-muted-foreground tabular-nums" data-testid="drive-page-summary"
        >{(firstShown + 1).toLocaleString('en-US')}–{Math.min(
          firstShown + PAGE_SIZE,
          shown.length,
        ).toLocaleString('en-US')} of {shown.length.toLocaleString('en-US')}</span
      >
      <button
        type="button"
        class="rounded-md border border-border px-2.5 py-1 hover:bg-muted disabled:opacity-50"
        disabled={currentPage === pageCount}
        onclick={nextPage}
        data-testid="drive-page-next">Next</button
      >
    </nav>
  {/if}

  {#if dragging && !draggedItem}
    <div
      class="pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-primary/5 backdrop-blur-[1px]"
      data-testid="drive-drop-overlay"
    >
      <UploadIcon class="size-8 text-primary" aria-hidden="true" />
      <p class="text-sm font-medium">Drop to upload to {dropDestination}</p>
    </div>
  {/if}
</section>

{#if clash}
  {#key clash.conflict}
    <UploadConflictDialog conflict={clash.conflict} onanswer={clash.answer} />
  {/key}
{/if}

{#if nameDialog}
  <NameDialog {...nameDialog} onclose={() => (nameDialog = null)} />
{/if}
