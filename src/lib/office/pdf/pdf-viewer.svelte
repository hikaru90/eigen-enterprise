<script lang="ts" module>
  import type PdfEditor from './pdf-editor.svelte'
  import type PdfOrganiser from './pdf-organiser.svelte'
  import type { ComponentProps } from 'svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { driveShownError } from '$lib/drive/shown-error'
  import type { AgentReport } from '$lib/errors/agent-report'

  type OrganiserProps = ComponentProps<typeof PdfOrganiser>
  type EditorProps = ComponentProps<typeof PdfEditor>
</script>

<script lang="ts">
  import type { OfficeViewerProps } from '../viewers'
  import type { TextContent } from 'pdfjs-dist/types/src/display/api'
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down'
  import ChevronUpIcon from '@lucide/svelte/icons/chevron-up'
  import LayoutGridIcon from '@lucide/svelte/icons/layout-grid'
  import ListTreeIcon from '@lucide/svelte/icons/list-tree'
  import LockIcon from '@lucide/svelte/icons/lock'
  import MaximizeIcon from '@lucide/svelte/icons/maximize'
  import MoonIcon from '@lucide/svelte/icons/moon'
  import MoveHorizontalIcon from '@lucide/svelte/icons/move-horizontal'
  import PanelLeftIcon from '@lucide/svelte/icons/panel-left'
  import PencilLineIcon from '@lucide/svelte/icons/pencil-line'
  import SearchIcon from '@lucide/svelte/icons/search'
  import XIcon from '@lucide/svelte/icons/x'
  import ZoomInIcon from '@lucide/svelte/icons/zoom-in'
  import ZoomOutIcon from '@lucide/svelte/icons/zoom-out'
  import { flushSync, onMount, tick, type Component } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { driveApi, type DriveItem } from '$lib/drive/api'
  import {
    findInPage,
    itemRanges,
    pageName,
    pageText,
    resolvePageInput,
    type PageText,
  } from './find'
  import {
    CSS_PER_POINT,
    fitPage,
    fitWidth,
    PAGE_GAP,
    PAGE_PAD,
    pageAt,
    pageTops,
    stepZoom,
    clampZoom,
    totalHeight,
    visibleRange,
    type PageSize,
  } from './layout'
  import { drawThumbnail, PageView, type Highlight } from './page-view'
  import {
    loadPdfJs,
    openPdf,
    type PdfDocument,
    type PdfJs,
    type PdfLoadingTask,
    type PdfPage,
  } from './pdfjs'

  /**
   * The Drive's PDF viewer (plan/phase-office-files.md, P1): every page in
   * one continuous scroll, drawn only near the viewport; thumbnails, the
   * file's bookmarks and page labels; zoom (fit width/page, steps,
   * ⌘/Ctrl+wheel, pinch) that keeps the reading position; find as you type;
   * selectable text. With edit access, "Organise pages" (P2,
   * ./pdf-organiser.svelte) rotates, deletes, reorders, inserts, extracts and
   * splits pages and saves them as a new revision. "Annotate & fill" (P3,
   * ./pdf-editor.svelte) adds notes, markups, drawings and shapes, fills the
   * form and sets the properties, saved as one new revision.
   */
  let { fileId, name, canEdit, heartbeatMs, onsaved, folderId, author }: OfficeViewerProps =
    $props()

  type OutlineNode = {
    title: string
    dest: string | unknown[] | null
    url: string | null
    items: OutlineNode[]
  }
  type Match = { page: number; start: number; end: number }
  type ZoomMode = 'fit-width' | 'fit-page' | 'custom'
  type Status =
    | { kind: 'loading' }
    | { kind: 'password'; incorrect: boolean }
    | { kind: 'error'; message: string; detail: string | null; agent: AgentReport | null }
    | { kind: 'ready' }

  const THUMB_WIDTH = 112

  let status = $state<Status>({ kind: 'loading' })
  let sizes = $state.raw<PageSize[]>([])
  let labels = $state.raw<string[] | null>(null)
  let outline = $state.raw<OutlineNode[]>([])
  let zoom = $state(1)
  let zoomMode = $state<ZoomMode>('fit-width')
  let current = $state(0)
  let sidebar = $state<'thumbnails' | 'outline' | null>(null)
  let darkPages = $state(false)
  let query = $state('')
  let matches = $state.raw<Match[]>([])
  let selected = $state.raw<Match | null>(null)
  let searching = $state(false)
  let pageDraft = $state<string | null>(null)
  let pageError = $state<string | null>(null)
  let navError = $state<string | null>(null)
  let password = $state('')
  /** Organise mode: the page grid replaces the reading view (loaded on first use). */
  let organiser = $state.raw<Component<OrganiserProps> | null>(null)
  let organising = $state(false)
  let organiseError = $state<string | null>(null)
  /** Annotate & fill: the editor replaces the reading view (loaded on first use). */
  let editor = $state.raw<Component<EditorProps> | null>(null)
  let editing = $state<'annotate' | 'form' | null>(null)
  /** After a save: what the new revision could not keep (or should know). */
  let savedNotice = $state.raw<{ text: string; warnings: string[] } | null>(null)
  let needsPassword = $state(false)

  const count = $derived(sizes.length)
  const tops = $derived(pageTops(sizes, zoom))
  const contentHeight = $derived(totalHeight(sizes, zoom))
  const contentWidth = $derived(
    Math.max(0, ...sizes.map((s) => Math.floor(s.width * zoom))) + 2 * PAGE_PAD,
  )
  const selectedIndex = $derived(
    selected
      ? matches.findIndex((m) => m.page === selected!.page && m.start === selected!.start)
      : -1,
  )
  const findStatus = $derived(
    !query.trim()
      ? ''
      : matches.length === 0
        ? searching
          ? 'Searching…'
          : 'No matches'
        : `${selectedIndex + 1} of ${matches.length}${searching ? '…' : ''}`,
  )
  const zoomLabel = $derived(`${Math.round(zoom * 100)}%`)
  /** Organise or Annotate & fill covers the reading view. */
  const hidden = $derived(organising || editing !== null)

  let root: HTMLDivElement
  let scroller: HTMLDivElement
  let sidebarEl: HTMLElement | null = $state(null)
  let findInput: HTMLInputElement | null = $state(null)
  let passwordInput: HTMLInputElement | null = $state(null)

  // The open document and what is on screen: plain fields, not view state.
  let lib = $state.raw<PdfJs | null>(null)
  let task: PdfLoadingTask | null = null
  let doc: PdfDocument | null = null
  let pages = $state.raw<PdfPage[]>([])
  /** The file's bytes as opened (pdf.js keeps its own copy): what Organise builds on. */
  let sourceBytes = $state.raw<Uint8Array | null>(null)
  let submitPassword: ((password: string) => void) | null = null
  let destroyed = false
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- page slots for the drawing code, never rendered
  const hosts = new Map<number, HTMLElement>()
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- drawn pages, never rendered
  const views = new Map<number, PageView>()
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a cache of pages' text, never rendered
  const texts = new Map<number, Promise<{ content: TextContent; text: PageText }>>()
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- which thumbnails are drawn, never rendered
  const thumbsDrawn = new Set<number>()
  let thumbObserver: IntersectionObserver | null = null
  let frame = 0
  let redrawTimer: ReturnType<typeof setTimeout> | null = null
  let findTimer: ReturnType<typeof setTimeout> | null = null
  let findRun = 0
  /** Where a jump (thumbnail, bookmark, keys) put the scroll; the current page stays the target until the reader scrolls on. */
  let pinned: { top: number; page: number } | null = null

  onMount(() => {
    const resize = new ResizeObserver(() => onResize())
    resize.observe(scroller)
    scroller.addEventListener('wheel', onWheel, { passive: false })
    thumbObserver = new IntersectionObserver(onThumbsSeen, { rootMargin: '200px 0px' })
    if (root.clientWidth >= 900) sidebar = 'thumbnails'
    void load()
    return () => {
      destroyed = true
      resize.disconnect()
      scroller.removeEventListener('wheel', onWheel)
      thumbObserver?.disconnect()
      if (frame) cancelAnimationFrame(frame)
      if (redrawTimer) clearTimeout(redrawTimer)
      if (findTimer) clearTimeout(findTimer)
      for (const v of views.values()) v.destroy()
      views.clear()
      void task?.destroy()
    }
  })

  async function load() {
    let bytes: Uint8Array
    try {
      bytes = await driveApi.readBytes(fileId)
    } catch (err) {
      fail('The file could not be loaded.', err)
      return
    }
    await openBytes(bytes)
  }

  async function openBytes(bytes: Uint8Array) {
    sourceBytes = bytes
    try {
      lib = await loadPdfJs()
      // pdf.js hands the buffer it is given over to its worker: it gets a copy.
      task = await openPdf(bytes.slice(), (submit, incorrect) => {
        submitPassword = submit
        needsPassword = true
        status = { kind: 'password', incorrect }
        void tick().then(() => passwordInput?.focus())
      })
      if (destroyed) {
        void task.destroy()
        return
      }
      doc = await task.promise
      pages = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc!.getPage(i + 1)))
      const [pageLabels, bookmarks] = await Promise.all([doc.getPageLabels(), doc.getOutline()])
      if (destroyed) return
      sizes = pages.map((p) => {
        const v = p.getViewport({ scale: CSS_PER_POINT })
        return { width: v.width, height: v.height }
      })
      labels = pageLabels
      outline = (bookmarks ?? []) as OutlineNode[]
    } catch (err) {
      if (destroyed) return
      if (lib && err instanceof lib.InvalidPDFException) {
        fail('This file is damaged or is not a PDF, so it can’t be shown.', err)
      } else {
        fail('The PDF could not be opened.', err)
      }
      return
    }
    status = { kind: 'ready' }
    flushSync()
    applyFit(zoomMode)
    updateVisible()
  }

  /** Shows other bytes of this file (after Organise saved, or when it changed meanwhile). */
  async function reopen(bytes: Uint8Array) {
    const old = task
    for (const v of views.values()) v.destroy()
    views.clear()
    texts.clear()
    thumbsDrawn.clear()
    query = ''
    matches = []
    selected = null
    pinned = null
    status = { kind: 'loading' }
    sizes = []
    await openBytes(bytes)
    void old?.destroy()
  }

  // --- organise ------------------------------------------------------------

  async function startOrganising() {
    organiseError = null
    savedNotice = null
    try {
      organiser ??= (await import('./pdf-organiser.svelte')).default
      organising = true
    } catch (err) {
      organiseError = `Organise could not be opened: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  async function startEditing() {
    organiseError = null
    savedNotice = null
    try {
      editor ??= (await import('./pdf-editor.svelte')).default
      editing = 'annotate'
    } catch (err) {
      organiseError = `Annotate could not be opened: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  function onEdited(file: DriveItem, bytes: Uint8Array, warnings: string[]) {
    editing = null
    savedNotice = {
      text: `Saved the changes as a new version${warnings.length ? '. Note:' : '.'}`,
      warnings,
    }
    onsaved?.(file)
    void reopen(bytes)
  }

  function onEditChangedMeanwhile(bytes: Uint8Array) {
    editing = null
    void reopen(bytes).then(() => {
      if (status.kind === 'ready') void startEditing()
    })
  }

  function onOrganised(file: DriveItem, bytes: Uint8Array, warnings: string[]) {
    organising = false
    savedNotice = {
      text: `Saved the pages as a new version${warnings.length ? '. Not everything could be kept:' : '.'}`,
      warnings,
    }
    onsaved?.(file)
    void reopen(bytes)
  }

  function onChangedMeanwhile(bytes: Uint8Array) {
    organising = false
    void reopen(bytes).then(() => {
      if (status.kind === 'ready') void startOrganising()
    })
  }

  function fail(message: string, err: unknown) {
    if (destroyed) return
    status = {
      kind: 'error',
      message,
      detail: err instanceof Error ? err.message : String(err),
      agent: driveShownError(err).agent,
    }
  }

  function onPasswordSubmit(event: SubmitEvent) {
    event.preventDefault()
    if (!submitPassword || !password) return
    const submit = submitPassword
    submitPassword = null
    const typed = password
    password = ''
    status = { kind: 'loading' }
    submit(typed)
  }

  // --- what is on screen -------------------------------------------------

  function devicePixelRatio() {
    return window.devicePixelRatio
  }

  function onScroll() {
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0
        updateVisible()
      })
    }
  }

  /** Draws the pages near the viewport (the current page first) and drops the ones far away. */
  function updateVisible() {
    if (destroyed || !scroller || status.kind !== 'ready' || count === 0) return
    const top = scroller.scrollTop
    const height = scroller.clientHeight
    if (pinned && Math.abs(pinned.top - top) < 2) {
      current = pinned.page
    } else {
      pinned = null
      const atEnd = top + height >= scroller.scrollHeight - 2
      current = atEnd && top > 0 ? count - 1 : pageAt(tops, top + height * 0.4)
    }
    followInSidebar()
    const [first, last] = visibleRange(tops, sizes, zoom, top, height, height / 2)
    for (const [i, view] of views) {
      if (i < first - 3 || i > last + 3) {
        view.destroy()
        views.delete(i)
      }
    }
    const order = Array.from({ length: last - first + 1 }, (_, k) => first + k).sort(
      (a, b) => Math.abs(a - current) - Math.abs(b - current),
    )
    const dpr = devicePixelRatio()
    for (const i of order) {
      const host = hosts.get(i)
      const page = pages[i]
      if (!host || !page || !lib) continue
      let view = views.get(i)
      if (!view) {
        view = new PageView(lib, page, host)
        views.set(i, view)
        const created = view
        void textOf(i)
          .then(({ content }) => created.showText(content))
          .then(() => paintHighlights(i))
          .catch((err) => showDrawError(err))
      }
      if (!view.isDrawnAt(zoom, dpr)) void view.draw(zoom, dpr).catch((err) => showDrawError(err))
    }
  }

  function showDrawError(err: unknown) {
    if (destroyed) return
    navError = `A page could not be drawn: ${err instanceof Error ? err.message : String(err)}`
  }

  function textOf(i: number) {
    let t = texts.get(i)
    if (!t) {
      t = pages[i]!.getTextContent().then((content) => ({
        content,
        text: pageText(content.items.filter((it) => 'str' in it)),
      }))
      texts.set(i, t)
    }
    return t
  }

  /** Registers a page slot (the PageView draws into it). */
  function pageSlot(i: number) {
    return (el: HTMLElement) => {
      hosts.set(i, el)
      return () => {
        if (hosts.get(i) === el) hosts.delete(i)
      }
    }
  }

  // --- moving around -----------------------------------------------------

  function goToPage(index: number, offsetY = 0) {
    if (count === 0) return
    const i = Math.min(count - 1, Math.max(0, index))
    scroller.scrollTop = tops[i]! - PAGE_GAP / 2 + offsetY
    pinned = { top: scroller.scrollTop, page: i }
    current = i
    updateVisible()
  }

  function onPageInputKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitPageInput()
    } else if (event.key === 'Escape') {
      pageDraft = null
      pageError = null
      ;(event.currentTarget as HTMLInputElement).blur()
    }
  }

  function commitPageInput() {
    if (pageDraft === null) return
    const target = resolvePageInput(pageDraft, labels, count)
    if (target === null) {
      pageError = `There is no page “${pageDraft.trim()}”.`
      return
    }
    pageDraft = null
    pageError = null
    goToPage(target)
  }

  async function openBookmark(node: OutlineNode) {
    navError = null
    if (!doc || !node.dest) return
    try {
      const dest = typeof node.dest === 'string' ? await doc.getDestination(node.dest) : node.dest
      if (!Array.isArray(dest) || dest.length === 0)
        throw new Error(`the bookmark “${node.title}” points nowhere`)
      const ref = dest[0]
      const index =
        typeof ref === 'number'
          ? ref
          : await doc.getPageIndex(ref as Parameters<PdfDocument['getPageIndex']>[0])
      const kind = (dest[1] as { name?: string } | undefined)?.name
      const y = kind === 'XYZ' ? dest[3] : kind === 'FitH' || kind === 'FitBH' ? dest[2] : null
      let offset = 0
      if (typeof y === 'number' && pages[index]) {
        const viewport = pages[index].getViewport({ scale: zoom * CSS_PER_POINT })
        offset = Math.max(0, viewport.convertToViewportPoint(0, y)[1]!)
      }
      goToPage(index, offset)
    } catch (err) {
      navError = `That bookmark can’t be opened: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  // --- zoom --------------------------------------------------------------

  /** Sets the zoom keeping the point under `anchor` (viewport coordinates; default the centre) in place. */
  function setZoom(next: number, mode: ZoomMode, anchor?: { x: number; y: number }) {
    const target = clampZoom(next)
    zoomMode = mode
    if (Math.abs(target - zoom) < 1e-4 || count === 0) return
    const a = anchor ?? { x: scroller.clientWidth / 2, y: scroller.clientHeight / 2 }
    const y = scroller.scrollTop + a.y
    const i = pageAt(tops, y)
    const within = (y - tops[i]!) / (sizes[i]!.height * zoom)
    const xRatio = (scroller.scrollLeft + a.x) / Math.max(scroller.scrollWidth, 1)
    zoom = target
    flushSync()
    scroller.scrollTop = tops[i]! + within * sizes[i]!.height * zoom - a.y
    scroller.scrollLeft = xRatio * scroller.scrollWidth - a.x
    if (pinned) pinned = { top: scroller.scrollTop, page: pinned.page }
    if (redrawTimer) clearTimeout(redrawTimer)
    redrawTimer = setTimeout(() => {
      redrawTimer = null
      updateVisible()
    }, 120)
  }

  function applyFit(mode: ZoomMode) {
    if (count === 0) return
    const width = scroller.clientWidth
    const height = scroller.clientHeight
    if (mode === 'fit-width') setZoom(fitWidth(sizes, width), mode, { x: 0, y: 0 })
    else if (mode === 'fit-page')
      setZoom(fitPage(sizes[current]!, width, height), mode, { x: 0, y: 0 })
    else zoomMode = mode
  }

  function onResize() {
    if (destroyed || !scroller || status.kind !== 'ready' || hidden) return
    if (zoomMode !== 'custom') applyFit(zoomMode)
    updateVisible()
  }

  function onWheel(event: WheelEvent) {
    if (!(event.ctrlKey || event.metaKey) || status.kind !== 'ready') return
    event.preventDefault()
    const rect = scroller.getBoundingClientRect()
    const perUnit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 0.05 : 0.002
    setZoom(zoom * Math.exp(-event.deltaY * perUnit), 'custom', {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    })
  }

  // Two-finger pinch on touch screens.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- pointer positions during a pinch, never rendered
  const touches = new Map<number, { x: number; y: number }>()
  let pinch: { distance: number; zoom: number } | null = null
  const spread = () => {
    const [a, b] = [...touches.values()]
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
  }
  function onPointerDown(event: PointerEvent) {
    // While selecting, the end-of-content block covers the page so the selection doesn't jump.
    if (event.target instanceof Element)
      event.target.closest('.textLayer')?.classList.add('selecting')
    if (event.pointerType !== 'touch') return
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (touches.size === 2) pinch = { distance: spread(), zoom }
  }
  function onPointerMove(event: PointerEvent) {
    if (!touches.has(event.pointerId)) return
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (!pinch || touches.size !== 2 || pinch.distance === 0) return
    const [a, b] = [...touches.values()]
    const rect = scroller.getBoundingClientRect()
    setZoom(pinch.zoom * (spread() / pinch.distance), 'custom', {
      x: (a!.x + b!.x) / 2 - rect.left,
      y: (a!.y + b!.y) / 2 - rect.top,
    })
  }
  function onPointerEnd(event: PointerEvent) {
    for (const layer of scroller.querySelectorAll('.textLayer.selecting'))
      layer.classList.remove('selecting')
    touches.delete(event.pointerId)
    if (touches.size < 2) pinch = null
  }

  // --- thumbnails --------------------------------------------------------

  /** Keeps the current page's thumbnail in view in the sidebar. */
  function followInSidebar() {
    if (sidebar !== 'thumbnails' || !sidebarEl) return
    const thumb = sidebarEl.querySelectorAll<HTMLElement>('[data-testid="pdf-thumb"]')[current]
    if (!thumb) return
    const top =
      thumb.getBoundingClientRect().top -
      sidebarEl.getBoundingClientRect().top +
      sidebarEl.scrollTop
    if (top < sidebarEl.scrollTop) sidebarEl.scrollTop = top - 8
    else if (top + thumb.offsetHeight > sidebarEl.scrollTop + sidebarEl.clientHeight) {
      sidebarEl.scrollTop = top + thumb.offsetHeight - sidebarEl.clientHeight + 8
    }
  }

  function thumbSlot(i: number) {
    return (el: HTMLElement) => {
      el.dataset.page = String(i)
      thumbObserver?.observe(el)
      return () => thumbObserver?.unobserve(el)
    }
  }

  function onThumbsSeen(entries: IntersectionObserverEntry[]) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const el = entry.target as HTMLElement
      const i = Number(el.dataset.page)
      if (thumbsDrawn.has(i) || !pages[i]) continue
      thumbsDrawn.add(i)
      thumbObserver?.unobserve(el)
      void drawThumbnail(pages[i], THUMB_WIDTH, devicePixelRatio())
        .then((canvas) => {
          if (destroyed) return
          el.querySelector('canvas')?.remove()
          el.prepend(canvas)
          el.dataset.drawn = 'true'
        })
        .catch((err) => showDrawError(err))
    }
  }

  function toggleSidebar(panel: 'thumbnails' | 'outline') {
    sidebar = sidebar === panel ? null : panel
    if (sidebar === 'thumbnails') thumbsDrawn.clear()
  }

  // --- find --------------------------------------------------------------

  function onFindInput() {
    if (findTimer) clearTimeout(findTimer)
    findTimer = setTimeout(() => {
      findTimer = null
      void runFind()
    }, 150)
  }

  /** Searches every page, starting at the current one; the first match found there is selected. */
  async function runFind() {
    const run = ++findRun
    const q = query
    matches = []
    selected = null
    for (const i of views.keys()) paintHighlights(i)
    if (!q.trim() || count === 0) {
      searching = false
      return
    }
    searching = true
    const start = current
    const found: Match[] = []
    for (let k = 0; k < count; k++) {
      const i = (start + k) % count
      const { text } = await textOf(i)
      if (run !== findRun || destroyed) return
      const onPage = findInPage(text, q).map((m) => ({ page: i, ...m }))
      if (onPage.length === 0) continue
      found.push(...onPage)
      matches = [...found].sort((a, b) => a.page - b.page || a.start - b.start)
      if (!selected) {
        selected = onPage[0]!
        void reveal(selected)
      }
      paintHighlights(i)
    }
    searching = false
  }

  function step(dir: 1 | -1) {
    if (matches.length === 0) return
    const from = selectedIndex === -1 ? (dir > 0 ? -1 : 0) : selectedIndex
    const before = selected
    selected = matches[(from + dir + matches.length) % matches.length]!
    if (before) paintHighlights(before.page)
    void reveal(selected)
  }

  /** Scrolls the match into view (a third down the viewport) and marks it. */
  async function reveal(match: Match) {
    const { content, text } = await textOf(match.page)
    if (destroyed || selected !== match) return
    const first = itemRanges(text, match.start, match.end)[0]
    const items = content.items.filter((it) => 'str' in it)
    const item = first ? items[first.item] : undefined
    let offset = 0
    if (item && 'transform' in item) {
      const viewport = pages[match.page]!.getViewport({ scale: zoom * CSS_PER_POINT })
      offset = viewport.convertToViewportPoint(item.transform[4], item.transform[5])[1]!
    }
    scroller.scrollTop = tops[match.page]! + offset - scroller.clientHeight / 3
    pinned = { top: scroller.scrollTop, page: match.page }
    current = match.page
    updateVisible()
    paintHighlights(match.page)
  }

  function paintHighlights(i: number) {
    const view = views.get(i)
    if (!view) return
    const onPage = matches.filter((m) => m.page === i)
    if (onPage.length === 0) {
      view.setHighlights([])
      return
    }
    void textOf(i).then(({ text }) => {
      const list: Highlight[] = []
      for (const m of matches.filter((x) => x.page === i)) {
        const isSelected = selected?.page === m.page && selected.start === m.start
        for (const r of itemRanges(text, m.start, m.end)) list.push({ ...r, selected: isSelected })
      }
      view.setHighlights(list)
    })
  }

  function onFindKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault()
      step(event.shiftKey ? -1 : 1)
    } else if (event.key === 'Escape') {
      if (query) {
        event.preventDefault()
        clearFind()
      } else {
        findInput?.blur()
      }
    }
  }

  function clearFind() {
    query = ''
    if (findTimer) clearTimeout(findTimer)
    void runFind()
  }

  // --- keys --------------------------------------------------------------

  function onKeydown(event: KeyboardEvent) {
    if (status.kind !== 'ready' || event.defaultPrevented || hidden) return
    const mod = event.metaKey || event.ctrlKey
    const target = event.target
    if (target instanceof Element && target.closest('[role="dialog"], [role="alertdialog"]')) return
    if (mod && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      findInput?.focus()
      findInput?.select()
      return
    }
    if (mod && (event.key === '=' || event.key === '+')) {
      event.preventDefault()
      setZoom(stepZoom(zoom, 1), 'custom')
      return
    }
    if (mod && event.key === '-') {
      event.preventDefault()
      setZoom(stepZoom(zoom, -1), 'custom')
      return
    }
    const editable =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    if (editable) return
    if (target instanceof Node && target !== document.body && !root.contains(target)) return
    const go: Record<string, () => number> = {
      PageDown: () => current + 1,
      PageUp: () => current - 1,
      Home: () => 0,
      End: () => count - 1,
    }
    const to = go[event.key]
    if (!to) return
    event.preventDefault()
    goToPage(to())
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#snippet bookmarks(nodes: OutlineNode[])}
  <ul class="flex flex-col gap-0.5" role="group">
    {#each nodes as node, i (i)}
      <li>
        {#if node.url}
          <!-- eslint-disable svelte/no-navigation-without-resolve -- a web link the PDF itself carries (pdf.js keeps only safe protocols) -->
          <a
            href={node.url}
            target="_blank"
            rel="noopener noreferrer"
            class="block truncate rounded px-2 py-1 text-sm hover:bg-muted">{node.title}</a
          >
          <!-- eslint-enable svelte/no-navigation-without-resolve -->
        {:else}
          <button
            type="button"
            class="block w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-muted disabled:opacity-50"
            disabled={!node.dest}
            title={node.title}
            onclick={() => openBookmark(node)}
            data-testid="pdf-bookmark">{node.title}</button
          >
        {/if}
        {#if node.items.length}
          <div class="pl-3">{@render bookmarks(node.items)}</div>
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

<div
  bind:this={root}
  class="pdf-viewer min-w-0"
  data-testid="pdf-viewer"
  data-status={status.kind}
  data-zoom={zoom}
>
  {#if editing && editor && sourceBytes && lib}
    {@const Editor = editor}
    <Editor
      {fileId}
      {name}
      {heartbeatMs}
      {author}
      {lib}
      base={{ bytes: sourceBytes, pages }}
      startIn={editing}
      onsaved={onEdited}
      onchanged={onEditChangedMeanwhile}
      onclose={() => (editing = null)}
    />
  {/if}
  {#if organising && organiser && sourceBytes}
    {@const Organiser = organiser}
    <Organiser
      {fileId}
      {name}
      {folderId}
      {heartbeatMs}
      base={{ bytes: sourceBytes, name, pages }}
      onsaved={onOrganised}
      onchanged={onChangedMeanwhile}
      onclose={() => (organising = false)}
    />
  {/if}
  <div
    class="flex flex-wrap items-center gap-1 border-b bg-muted/30 px-2 py-1.5 text-sm"
    role="toolbar"
    aria-label="PDF tools"
    style:display={hidden ? 'none' : undefined}
  >
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Page thumbnails"
      aria-pressed={sidebar === 'thumbnails'}
      title="Page thumbnails"
      disabled={status.kind !== 'ready'}
      onclick={() => toggleSidebar('thumbnails')}
      data-testid="pdf-toggle-thumbnails"><PanelLeftIcon class="size-4" /></Button
    >
    {#if outline.length}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Bookmarks"
        aria-pressed={sidebar === 'outline'}
        title="Bookmarks"
        onclick={() => toggleSidebar('outline')}
        data-testid="pdf-toggle-outline"><ListTreeIcon class="size-4" /></Button
      >
    {/if}
    <span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
    <label class="flex items-center gap-1.5 text-muted-foreground">
      <span class="sr-only">Page</span>
      <input
        class="h-7 w-14 rounded-md border bg-background px-1.5 text-center text-sm text-foreground tabular-nums"
        aria-label="Page"
        aria-invalid={pageError ? 'true' : undefined}
        value={pageDraft ?? (count ? pageName(labels, current) : '')}
        disabled={status.kind !== 'ready'}
        oninput={(e) => {
          pageDraft = e.currentTarget.value
          pageError = null
        }}
        onkeydown={onPageInputKeydown}
        onblur={() => {
          pageDraft = null
          pageError = null
        }}
        data-testid="pdf-page-input"
      />
      <span class="tabular-nums whitespace-nowrap" data-testid="pdf-page-count"
        >{labels && count ? `(${current + 1} of ${count})` : `of ${count}`}</span
      >
    </label>
    <span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Zoom out"
      title="Zoom out (⌘−)"
      disabled={status.kind !== 'ready'}
      onclick={() => setZoom(stepZoom(zoom, -1), 'custom')}
      data-testid="pdf-zoom-out"><ZoomOutIcon class="size-4" /></Button
    >
    <span
      class="w-12 text-center text-xs tabular-nums"
      aria-live="polite"
      data-testid="pdf-zoom-label">{zoomLabel}</span
    >
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Zoom in"
      title="Zoom in (⌘+)"
      disabled={status.kind !== 'ready'}
      onclick={() => setZoom(stepZoom(zoom, 1), 'custom')}
      data-testid="pdf-zoom-in"><ZoomInIcon class="size-4" /></Button
    >
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Fit width"
      aria-pressed={zoomMode === 'fit-width'}
      title="Fit width"
      disabled={status.kind !== 'ready'}
      onclick={() => applyFit('fit-width')}
      data-testid="pdf-fit-width"><MoveHorizontalIcon class="size-4" /></Button
    >
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Fit page"
      aria-pressed={zoomMode === 'fit-page'}
      title="Fit page"
      disabled={status.kind !== 'ready'}
      onclick={() => applyFit('fit-page')}
      data-testid="pdf-fit-page"><MaximizeIcon class="size-4" /></Button
    >
    {#if canEdit}
      <Button
        variant="ghost"
        size="sm"
        title={needsPassword
          ? 'Password-protected PDFs can’t be organised yet'
          : 'Rotate, delete, reorder, insert and extract pages'}
        disabled={status.kind !== 'ready' || needsPassword}
        onclick={startOrganising}
        data-testid="pdf-organise"><LayoutGridIcon class="size-4" /> Organise pages</Button
      >
      <Button
        variant="ghost"
        size="sm"
        title={needsPassword
          ? 'Password-protected PDFs can’t be annotated yet'
          : 'Notes, highlights, drawings, the form and the properties'}
        disabled={status.kind !== 'ready' || needsPassword}
        onclick={startEditing}
        data-testid="pdf-annotate"><PencilLineIcon class="size-4" /> Annotate &amp; fill</Button
      >
    {/if}
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Dark pages"
      aria-pressed={darkPages}
      title="Dark pages (inverts the page colours on screen)"
      disabled={status.kind !== 'ready'}
      onclick={() => (darkPages = !darkPages)}
      data-testid="pdf-dark-pages"><MoonIcon class="size-4" /></Button
    >
    <div class="ml-auto flex items-center gap-1" role="search">
      <div class="relative">
        <SearchIcon
          class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <input
          bind:this={findInput}
          bind:value={query}
          type="search"
          class="h-7 w-44 rounded-md border bg-background pr-2 pl-7 text-sm"
          placeholder="Find in document"
          aria-label="Find in document"
          disabled={status.kind !== 'ready'}
          oninput={onFindInput}
          onkeydown={onFindKeydown}
          data-testid="pdf-find"
        />
      </div>
      <span
        class="min-w-16 text-xs whitespace-nowrap text-muted-foreground tabular-nums"
        aria-live="polite"
        data-testid="pdf-find-status">{findStatus}</span
      >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={matches.length === 0}
        onclick={() => step(-1)}
        data-testid="pdf-find-prev"><ChevronUpIcon class="size-4" /></Button
      >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={matches.length === 0}
        onclick={() => step(1)}
        data-testid="pdf-find-next"><ChevronDownIcon class="size-4" /></Button
      >
      {#if query}
        <Button variant="ghost" size="icon-sm" aria-label="Clear find" onclick={clearFind}
          ><XIcon class="size-4" /></Button
        >
      {/if}
    </div>
  </div>
  {#if !hidden && organiseError}
    <ErrorNotice
      class="border-b border-destructive/40 bg-destructive/10 px-3 py-1.5"
      testid="pdf-organise-notice"
      error={organiseError}
      attempted="Opening the PDF organiser or annotator in the browser"
    />
  {:else if !hidden && savedNotice}
    <div
      class="border-b bg-muted/40 px-3 py-1.5 text-sm"
      role="status"
      data-testid="pdf-organise-notice"
    >
      {#if savedNotice}
        <p class="flex items-center gap-2">
          <span class="flex-1">{savedNotice.text}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Dismiss"
            onclick={() => (savedNotice = null)}><XIcon class="size-4" /></Button
          >
        </p>
        {#if savedNotice.warnings.length}
          <ul class="list-disc pl-5" data-testid="pdf-organise-warnings">
            {#each savedNotice.warnings as w (w)}<li>{w}</li>{/each}
          </ul>
        {/if}
      {/if}
    </div>
  {/if}
  {#if !hidden && (pageError || navError)}
    <ErrorNotice
      class="border-b border-destructive/40 bg-destructive/10 px-3 py-1.5"
      testid="pdf-nav-error"
      error={pageError ?? navError ?? ''}
      attempted="Going to a page or bookmark in the PDF viewer"
    />
  {/if}

  <div class="pdf-body" style:display={hidden ? 'none' : undefined}>
    {#if sidebar && status.kind === 'ready'}
      <nav
        bind:this={sidebarEl}
        class="pdf-sidebar border-r bg-muted/20 p-2"
        aria-label={sidebar === 'thumbnails' ? 'Page thumbnails' : 'Bookmarks'}
        data-testid={sidebar === 'thumbnails' ? 'pdf-thumbnails' : 'pdf-outline'}
      >
        {#if sidebar === 'thumbnails'}
          <ol class="flex flex-col items-center gap-3">
            {#each sizes as size, i (i)}
              <li>
                <button
                  type="button"
                  class="pdf-thumb flex flex-col items-center gap-1 rounded-md p-1 text-xs text-muted-foreground hover:bg-muted aria-[current=page]:bg-muted aria-[current=page]:text-foreground"
                  aria-label={`Page ${pageName(labels, i)}`}
                  aria-current={i === current ? 'page' : undefined}
                  onclick={() => goToPage(i)}
                  data-testid="pdf-thumb"
                >
                  <span
                    class="pdf-thumb-frame"
                    style:width={`${THUMB_WIDTH}px`}
                    style:height={`${Math.round((size.height / size.width) * THUMB_WIDTH)}px`}
                    {@attach thumbSlot(i)}
                  ></span>
                  <span class="tabular-nums">{pageName(labels, i)}</span>
                </button>
              </li>
            {/each}
          </ol>
        {:else}
          {@render bookmarks(outline)}
        {/if}
      </nav>
    {/if}

    <div class="pdf-main">
      <div
        bind:this={scroller}
        class="pdf-scroller bg-muted/40"
        class:dark-pages={darkPages}
        role="region"
        aria-label={`Pages of ${name}`}
        tabindex="-1"
        onscroll={onScroll}
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerEnd}
        onpointercancel={onPointerEnd}
        data-testid="pdf-pages"
      >
        {#if status.kind === 'ready'}
          <div
            class="pdf-column"
            style:height={`${contentHeight}px`}
            style:min-width={`${contentWidth}px`}
            style:--total-scale-factor={zoom * CSS_PER_POINT}
          >
            {#each sizes as size, i (i)}
              <div
                class="pdf-page"
                style:top={`${tops[i]}px`}
                style:width={`${Math.floor(size.width * zoom)}px`}
                style:height={`${Math.floor(size.height * zoom)}px`}
                role="group"
                aria-label={`Page ${pageName(labels, i)}`}
                data-testid="pdf-page"
                data-page={i}
                {@attach pageSlot(i)}
              ></div>
            {/each}
          </div>
        {/if}
      </div>

      {#if status.kind === 'loading'}
        <div
          class="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground"
          data-testid="pdf-loading"
        >
          Opening {name}…
        </div>
      {:else if status.kind === 'password'}
        <div class="absolute inset-0 flex items-center justify-center p-6">
          <form
            class="flex w-full max-w-sm flex-col gap-3 rounded-lg border bg-card p-5 shadow-sm"
            onsubmit={onPasswordSubmit}
            data-testid="pdf-password"
          >
            <p class="flex items-center gap-2 font-medium">
              <LockIcon class="size-4" /> This PDF is password-protected
            </p>
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-muted-foreground">Enter the password to open it.</span>
              <input
                bind:this={passwordInput}
                bind:value={password}
                type="password"
                autocomplete="off"
                class="h-8 rounded-md border bg-background px-2 text-sm"
                aria-label="Password"
                aria-invalid={status.incorrect ? 'true' : undefined}
                data-testid="pdf-password-input"
              />
            </label>
            {#if status.incorrect}
              <ErrorNotice
                testid="pdf-password-wrong"
                error="That password is not right. Try again."
                attempted="Opening a password-protected PDF in the browser (the typed password was refused; it is never copied)"
              />
            {/if}
            <Button
              type="submit"
              class="self-end"
              disabled={!password}
              data-testid="pdf-password-submit">Open</Button
            >
          </form>
        </div>
      {:else if status.kind === 'error'}
        <ErrorNotice
          class="absolute inset-0 items-center justify-center gap-2 p-6 text-center font-medium"
          testid="pdf-error"
          error={status.message}
          agent={status.agent}
          attempted="Opening a PDF in the browser viewer"
        >
          {#if status.detail}
            <p
              class="max-w-md text-xs font-normal text-muted-foreground"
              data-testid="pdf-error-detail"
            >
              {status.detail}
            </p>
          {/if}
          <p class="text-sm font-normal text-muted-foreground">You can still download the file.</p>
        </ErrorNotice>
      {/if}
    </div>
  </div>
</div>

<style>
  /* Structure (also without Tailwind, e.g. in component tests). */
  .pdf-viewer {
    display: flex;
    flex-direction: column;
    flex: 1;
    height: 78vh;
    min-height: 24rem;
  }
  .pdf-body {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .pdf-sidebar {
    width: 11rem;
    flex-shrink: 0;
    overflow-y: auto;
  }
  .pdf-main {
    position: relative;
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }
  .pdf-scroller {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    touch-action: pan-x pan-y;
    outline: none;
    /* pdf.js sizes the text layer with these. */
    --scale-round-x: 1px;
    --scale-round-y: 1px;
  }
  .pdf-column {
    position: relative;
    margin: 0 auto;
  }
  .pdf-page {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    background: white;
    box-shadow:
      0 0 0 1px rgb(0 0 0 / 0.08),
      0 1px 3px rgb(0 0 0 / 0.12);
    overflow: hidden;
  }
  .pdf-page :global(.pdf-canvas) {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .dark-pages .pdf-page {
    background: black;
  }
  .dark-pages .pdf-page :global(.pdf-canvas) {
    filter: invert(1) hue-rotate(180deg);
  }
  .pdf-thumb-frame {
    position: relative;
    display: block;
    background: white;
    box-shadow: 0 0 0 1px rgb(0 0 0 / 0.12);
  }
  .pdf-thumb-frame :global(canvas) {
    width: 100%;
    height: 100%;
  }
  .pdf-thumb[aria-current='page'] .pdf-thumb-frame {
    box-shadow: 0 0 0 2px var(--ring, #2563eb);
  }

  /* The text layer: transparent text over the canvas, for selection and find.
     Adapted from pdf.js's viewer stylesheet (Apache-2.0). */
  .pdf-page :global(.textLayer) {
    color-scheme: only light;
    position: absolute;
    text-align: initial;
    inset: 0;
    overflow: clip;
    opacity: 1;
    line-height: 1;
    letter-spacing: normal;
    word-spacing: normal;
    text-size-adjust: none;
    forced-color-adjust: none;
    transform-origin: 0 0;
    caret-color: CanvasText;
    z-index: 0;
    --min-font-size: 1;
    --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
    --min-font-size-inv: calc(1 / var(--min-font-size));
  }
  .pdf-page :global(.textLayer :is(span, br)) {
    color: transparent;
    position: absolute;
    white-space: pre;
    cursor: text;
    transform-origin: 0% 0%;
    user-select: text;
  }
  .pdf-page :global(.textLayer > :not(.markedContent)),
  .pdf-page :global(.textLayer .markedContent span:not(.markedContent)) {
    z-index: 1;
    --font-height: 0;
    font-size: calc(var(--text-scale-factor) * var(--font-height));
    --scale-x: 1;
    --rotate: 0deg;
    transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
  }
  .pdf-page :global(.textLayer .markedContent) {
    display: contents;
  }
  .pdf-page :global(.textLayer .highlight) {
    position: static;
    margin: -1px;
    padding: 1px;
    border-radius: 3px;
    background-color: rgb(250 204 21 / 0.45);
  }
  .pdf-page :global(.textLayer .highlight.selected) {
    background-color: rgb(234 88 12 / 0.5);
  }
  .pdf-page :global(.textLayer ::selection) {
    background: color-mix(in srgb, AccentColor, transparent 50%);
    color: transparent;
  }
  .pdf-page :global(.textLayer br::selection) {
    background: transparent;
  }
  .pdf-page :global(.textLayer .endOfContent) {
    display: block;
    position: absolute;
    inset: 100% 0 0;
    z-index: 0;
    cursor: default;
    user-select: none;
  }
  .pdf-page :global(.textLayer.selecting .endOfContent) {
    top: 0;
  }
</style>
