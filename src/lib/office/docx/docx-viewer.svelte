<script lang="ts">
  import type { OfficeViewerProps } from '../viewers'
  import type { RenderEnv } from './render'
  import type { Node as PMNode } from 'prosemirror-model'
  import type { EditorState } from 'prosemirror-state'
  import CheckIcon from '@lucide/svelte/icons/check'
  import CircleAlertIcon from '@lucide/svelte/icons/circle-alert'
  import DownloadIcon from '@lucide/svelte/icons/download'
  import InfoIcon from '@lucide/svelte/icons/info'
  import LoaderIcon from '@lucide/svelte/icons/loader-circle'
  import LockIcon from '@lucide/svelte/icons/lock'
  import MoveHorizontalIcon from '@lucide/svelte/icons/move-horizontal'
  import PencilIcon from '@lucide/svelte/icons/pencil'
  import ZoomInIcon from '@lucide/svelte/icons/zoom-in'
  import ZoomOutIcon from '@lucide/svelte/icons/zoom-out'
  import { onMount, tick, untrack } from 'svelte'
  import { beforeNavigate, goto } from '$app/navigation'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { driveApi, type LockHolder } from '$lib/drive/api'
  import { createAutosave, type Autosave, type AutosaveState } from '$lib/drive/autosave'
  import { createOfficeEditSession } from '../edit-session'
  import EditToolbar from './edit-toolbar.svelte'
  import { insertImage, linkAt, setLink } from './edit/commands'
  import { createDocxEditor, type DocxEditorView } from './edit/editor'
  import { IMAGE_TYPES, openForEditing, type DocxEditSession } from './edit/session'
  import { parseDocx } from './model'
  import { LayoutAborted, paginate } from './paginate'
  import { PX_PER_PT } from './render'

  /**
   * Word documents (plan/phase-office-files.md D1 + D2). The Print layout
   * shows the pages at their true size — margins, headers and footers,
   * content flowing from page to page — with zoom. With edit access, Edit
   * switches to a continuous page-wide layout in the document's own styles
   * (no live pagination while typing); Done goes back to Print, laid out
   * again from the edited document.
   *
   * Editing follows the Drive's rules (W-6): the lock is taken on the first
   * change, kept by a heartbeat, let go after `idleMs` without a change
   * (everything saved first). Changes autosave (debounced, one revision per
   * editing session) as .docx bytes that keep everything the editor doesn't
   * model. When someone else holds or takes the lock, this copy turns
   * read-only, says who, keeps the unsaved changes on screen (and to
   * download), and offers Take over. Leaving waits for the last save.
   */
  let {
    fileId,
    name,
    canEdit,
    heartbeatMs,
    onsaved,
    saveDelayMs = 1500,
    idleMs = 60_000,
  }: OfficeViewerProps & { saveDelayMs?: number; idleMs?: number } = $props()

  type Phase = 'loading' | 'layout' | 'ready' | 'error'
  let phase = $state<Phase>('loading')
  let error = $state<string | null>(null)
  let notices = $state<string[]>([])
  let pageCount = $state(0)
  let pageLabels = $state<string[]>([])
  let current = $state(1)
  /** 'fit' follows the width of the view; a number is a fixed zoom (1 = 100%). */
  let zoom = $state<'fit' | number>('fit')
  let fitScale = $state(1)
  let widestPt = $state(612)
  let scroller = $state<HTMLDivElement>()
  let host = $state<HTMLDivElement>()

  const scale = $derived(zoom === 'fit' ? fitScale : zoom)
  const percent = $derived(Math.round(scale * 100))

  /** Picture types a browser shows in <img>; others (EMF, WMF, TIFF) get a placeholder. */
  const SHOWN = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/bmp', 'image/webp', 'image/svg+xml', 'image/x-icon', 'image/avif'])

  // ---------------------------------------------------------------- editing state

  type Lock = { kind: 'idle' } | { kind: 'starting' } | { kind: 'editing' } | { kind: 'locked'; holder: LockHolder | null; tookOver: boolean }
  let layout = $state<'print' | 'edit'>('print')
  let lock = $state<Lock>({ kind: 'idle' })
  let save = $state<AutosaveState>({ status: 'saved', error: null, savedAt: null })
  let lockError = $state<string | null>(null)
  let pmState = $state.raw<EditorState | null>(null)
  let session = $state.raw<DocxEditSession | null>(null)
  let editor = $state.raw<DocxEditorView | null>(null)
  let editHost = $state<HTMLDivElement>()
  let sheet = $state({ widthPt: 612, top: 72, right: 72, bottom: 72, left: 72 })
  let linkOpen = $state(false)
  let linkValue = $state('')
  let linkError = $state<string | null>(null)
  let imageError = $state<string | null>(null)
  let fileInput = $state<HTMLInputElement>()
  /** Whether this copy has changes the server doesn't have. */
  let dirty = $state(false)

  /** The file as last loaded or saved (what Print shows when nothing changed). */
  let bytes: Uint8Array | null = null
  let savedDoc: PMNode | null = null
  /** Document versions waiting to be saved (the autosave works on version tokens). */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a plain version→document lookup, never rendered
  const snapshots = new Map<number, PMNode>()
  let version = 0
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let starting: Promise<void> | null = null
  const objectUrls: string[] = []

  const edits = createOfficeEditSession({
    fileId: untrack(() => fileId),
    heartbeatMs: untrack(() => heartbeatMs),
    onLost: (holder) => loseLock(holder, true),
  })
  let autosave: Autosave = makeAutosave()

  function makeAutosave(): Autosave {
    return createAutosave({
      delayMs: untrack(() => saveDelayMs),
      onState: (s) => (save = s),
      onLost: () => loseLock(null, true),
      async save(token) {
        const v = Number(token)
        const doc = snapshots.get(v)
        if (!doc || !session) throw new Error('There is nothing to save.')
        const out = session.serialize(doc)
        const file = await edits.save(out)
        bytes = out
        savedDoc = doc
        for (const k of [...snapshots.keys()]) if (k < v) snapshots.delete(k)
        dirty = !!editor && !editor.view.state.doc.eq(doc)
        onsaved?.(file)
      },
    })
  }

  // ---------------------------------------------------------------- print layout

  function measureFit() {
    if (!scroller) return
    const available = scroller.clientWidth - 32
    if (available <= 0) return
    fitScale = Math.max(0.2, Math.min(2, available / (widestPt * PX_PER_PT)))
  }

  function onScroll() {
    if (!scroller || !host || layout !== 'print') return
    const y = scroller.scrollTop + scroller.clientHeight / 3 - host.offsetTop
    const frames = host.children
    let n = 1
    for (let i = 0; i < frames.length; i++) {
      if ((frames[i] as HTMLElement).offsetTop <= y) n = i + 1
      else break
    }
    current = n
  }

  /** Links to a bookmark inside the document scroll to it instead of navigating. */
  function onClick(event: MouseEvent) {
    const target = event.target
    if (!(target instanceof Element) || !host) return
    const a = target.closest<HTMLAnchorElement>('a[data-anchor]')
    if (!a) return
    event.preventDefault()
    const mark = host.querySelector(`[data-bookmark="${CSS.escape(a.dataset.anchor ?? '')}"]`)
    mark?.scrollIntoView({ block: 'start' })
  }

  function zoomBy(step: number) {
    const next = Math.round((scale + step) * 10) / 10
    zoom = Math.max(0.3, Math.min(3, next))
  }

  let layoutRun: AbortController | null = null
  let pageUrls: string[] = []

  onMount(() => {
    const resize = new ResizeObserver(() => measureFit())
    if (scroller) resize.observe(scroller)
    void open()
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsaved()) return
      void autosave.flush()
      event.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      layoutRun?.abort()
      resize.disconnect()
      clearIdle()
      window.removeEventListener('beforeunload', onBeforeUnload)
      for (const u of [...pageUrls, ...objectUrls]) URL.revokeObjectURL(u)
      if (lock.kind === 'editing') void autosave.flush().then(() => edits.stop())
      editor?.destroy()
    }
  })

  // In-app navigation waits for the last save, then continues.
  let leaving = false
  beforeNavigate((nav) => {
    if (leaving || (lock.kind !== 'editing' && lock.kind !== 'starting')) return
    if (!hasUnsaved() && save.status !== 'saving' && lock.kind === 'editing') return
    if (nav.type === 'leave' || nav.type === 'popstate' || !nav.to?.url) {
      void autosave.flush()
      return
    }
    const to = nav.to.url
    nav.cancel()
    leaving = true
    void (starting ?? Promise.resolve())
      .then(() => autosave.flush())
      .then(async () => {
        try {
          if (save.status === 'error' && !confirm('Your latest changes could not be saved. Leave anyway and lose them?')) return
          // eslint-disable-next-line svelte/no-navigation-without-resolve -- the navigation the person already started
          await goto(to.href, { invalidateAll: true })
        } finally {
          leaving = false
        }
      })
  })

  async function open() {
    try {
      bytes = await driveApi.readBytes(fileId)
      await renderPages(bytes)
    } catch (err) {
      if (err instanceof LayoutAborted) return
      error = err instanceof Error ? err.message : String(err)
      phase = 'error'
    }
  }

  /** Lays the pages out (again) from `source`. */
  async function renderPages(source: Uint8Array) {
    layoutRun?.abort()
    const controller = new AbortController()
    layoutRun = controller
    const signal = controller.signal
    for (const u of pageUrls) URL.revokeObjectURL(u)
    pageUrls = []
    const doc = parseDocx(source)
    notices = doc.notices
    widestPt = Math.max(...doc.sections.map((s) => s.props.pageWidthPt))
    phase = 'layout'
    pageCount = 0
    measureFit()
    await tick()
    await document.fonts?.ready
    if (signal.aborted || !host) return
    // eslint-disable-next-line svelte/no-dom-manipulating -- the pages are built outside Svelte's markup (paginate.ts)
    host.replaceChildren()
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a plain lookup cache for object URLs, never rendered
    const cache = new Map<string, string | null>()
    const urls = pageUrls
    const env: Omit<RenderEnv, 'pageField'> = {
      doc,
      document,
      imageUrl(part, contentType) {
        if (cache.has(part)) return cache.get(part)!
        const type = (contentType ?? '').toLowerCase()
        let url: string | null = null
        if (SHOWN.has(type)) {
          url = URL.createObjectURL(new Blob([doc.pkg.bytes(part).slice()], { type }))
          urls.push(url)
        }
        cache.set(part, url)
        return url
      },
    }
    try {
      const pages = await paginate(doc, host, env, { signal, onPage: (n) => (pageCount = n) })
      pageLabels = pages.map((p) => p.number)
      pageCount = pages.length
      phase = 'ready'
      onScroll()
    } catch (err) {
      if (err instanceof LayoutAborted || signal.aborted) return
      throw err
    }
  }

  // ---------------------------------------------------------------- edit layout

  function imageUrlFor(s: () => DocxEditSession | null) {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a plain lookup cache for object URLs, never rendered
    const cache = new Map<string, string | null>()
    return (part: string, contentType: string | null) => {
      if (cache.has(part)) return cache.get(part)!
      const current = s()
      const type = (contentType ?? '').toLowerCase()
      let url: string | null = null
      if (current && SHOWN.has(type) && current.docx.pkg.has(part)) {
        url = URL.createObjectURL(new Blob([current.docx.pkg.bytes(part).slice()], { type }))
        objectUrls.push(url)
      }
      cache.set(part, url)
      return url
    }
  }

  async function mountEditor(source: Uint8Array) {
    editor?.destroy()
    let made: DocxEditSession | null = null
    made = openForEditing(source, { imageUrl: imageUrlFor(() => made) })
    session = made
    const first = made.docx.sections[0]!.props
    sheet = { widthPt: first.pageWidthPt, top: first.margin.topPt, right: first.margin.rightPt, bottom: first.margin.bottomPt, left: first.margin.leftPt }
    savedDoc = made.initial
    snapshots.clear()
    version = 0
    dirty = false
    await tick()
    if (!editHost) return
    // eslint-disable-next-line svelte/no-dom-manipulating -- ProseMirror builds the editor's DOM itself
    editHost.replaceChildren()
    editor = createDocxEditor(editHost, made, {
      editable: lock.kind !== 'locked',
      onChange,
      onState: (s) => (pmState = s),
      onLink: openLink,
    })
    pmState = editor.view.state
  }

  async function startEdit() {
    lockError = null
    try {
      if (!session) await mountEditor(bytes!)
      layout = 'edit'
      await tick()
      editor?.view.focus()
    } catch (err) {
      lockError = `This document can't be edited here: ${err instanceof Error ? err.message : String(err)}`
      layout = 'print'
    }
  }

  /** Back to the Print layout: everything saved and the lock let go first, then the pages laid out from the edited document. */
  async function finishEdit() {
    clearIdle()
    await starting
    if (lock.kind === 'editing') {
      await autosave.flush()
      if (save.status === 'error') return
      await edits.stop()
      lock = { kind: 'idle' }
    }
    layout = 'print'
    if (session && editor) {
      const shown = editor.view.state.doc.eq(session.initial) && bytes ? bytes : session.serialize(editor.view.state.doc)
      await tick()
      try {
        await renderPages(shown)
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
        phase = 'error'
      }
    }
  }

  function hasUnsaved() {
    return autosave.unsaved() !== null || (dirty && lock.kind !== 'locked')
  }

  function onChange(doc: PMNode) {
    version++
    snapshots.set(version, doc)
    dirty = !savedDoc || !doc.eq(savedDoc)
    if (lock.kind === 'editing') {
      autosave.change(String(version))
      touchIdle()
    } else if (lock.kind === 'idle') void startEditing(false)
  }

  function startEditing(takeover: boolean): Promise<void> {
    starting = takeLock(takeover).finally(() => (starting = null))
    return starting
  }

  async function takeLock(takeover: boolean) {
    lockError = null
    const was = lock
    lock = { kind: 'starting' }
    try {
      const view = await edits.start({ takeover })
      if (view.state === 'held') {
        if (takeover) {
          // Taking over: the other person's saved version becomes this copy (yours stays downloadable until now).
          const fresh = await driveApi.readBytes(fileId)
          bytes = fresh
          autosave = makeAutosave()
          save = { status: 'saved', error: null, savedAt: null }
          lock = { kind: 'editing' }
          await mountEditor(fresh)
        } else {
          lock = { kind: 'editing' }
          editor?.setEditable(true)
          if (dirty) autosave.change(String(version))
        }
        touchIdle()
      } else if (view.state === 'locked') {
        // Someone else is editing: this copy turns read-only; what was typed stays on screen.
        editor?.setEditable(false)
        lock = { kind: 'locked', holder: view.holder, tookOver: false }
      } else lock = was.kind === 'starting' ? { kind: 'idle' } : was
    } catch (err) {
      lock = was.kind === 'starting' ? { kind: 'idle' } : was
      lockError = err instanceof Error ? err.message : String(err)
    }
  }

  function loseLock(holder: LockHolder | null, tookOver: boolean) {
    if (lock.kind === 'locked') {
      if (holder && !lock.holder) lock = { ...lock, holder }
      return
    }
    clearIdle()
    autosave.stop()
    editor?.setEditable(false)
    lock = { kind: 'locked', holder, tookOver }
  }

  function clearIdle() {
    if (idleTimer !== null) clearTimeout(idleTimer)
    idleTimer = null
  }

  /** Editing ends after a quiet spell: save what is left, let go of the lock (the next change takes it again). */
  function touchIdle() {
    clearIdle()
    idleTimer = setTimeout(() => void releaseWhenIdle(), idleMs)
  }

  async function releaseWhenIdle() {
    clearIdle()
    if (lock.kind !== 'editing') return
    await autosave.flush()
    if (lock.kind !== 'editing' || autosave.unsaved() !== null || save.status !== 'saved') {
      if (lock.kind === 'editing') touchIdle()
      return
    }
    await edits.stop()
    lock = { kind: 'idle' }
  }

  function downloadDraft() {
    if (!session || !editor) return
    const blob = new Blob([session.serialize(editor.view.state.doc).slice()], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name.replace(/\.docx$/i, '') + ' (my changes).docx'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  // ---------------------------------------------------------------- links and pictures

  function openLink() {
    if (!pmState) return
    const link = linkAt(pmState)
    linkValue = link ? ((link.attrs.href as string | null) ?? (link.attrs.anchor ? `#${link.attrs.anchor as string}` : '')) : ''
    linkError = null
    linkOpen = true
  }

  /** Web, mail and phone addresses, or "#bookmark" for a place in the document. */
  const LINK_TARGET = /^(https?:\/\/\S+|mailto:\S+|tel:\S+|#\S+)$/i

  function applyLink(event: SubmitEvent) {
    event.preventDefault()
    const value = linkValue.trim()
    if (!LINK_TARGET.test(value)) {
      linkError = 'Use a web address (https://…), an email (mailto:…), a phone number (tel:…) or #bookmark.'
      return
    }
    editor?.run(setLink(value))
    linkOpen = false
  }

  function removeLink() {
    editor?.run(setLink(null))
    linkOpen = false
  }

  async function onPicture(event: Event) {
    imageError = null
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file || !session || !editor) return
    if (!IMAGE_TYPES[file.type]) {
      imageError = `${file.name} is not a PNG, JPEG or GIF picture.`
      return
    }
    try {
      const data = new Uint8Array(await file.arrayBuffer())
      const bitmap = await createImageBitmap(file)
      const size = { widthPt: bitmap.width * 0.75, heightPt: bitmap.height * 0.75 }
      bitmap.close()
      editor.run(insertImage(session, { bytes: data, contentType: file.type, ...size, name: file.name }))
    } catch (err) {
      imageError = `${file.name} could not be added: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  const readOnly = $derived(lock.kind === 'locked')
  const fmtTime = (d: Date) => d.toLocaleTimeString(undefined, { timeStyle: 'short' })
</script>

<div class="flex min-h-0 flex-1 flex-col" data-testid="docx-viewer" data-layout={layout}>
  <div class="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm" role="toolbar" aria-label="Document view">
    {#if layout === 'print'}
      <span class="tabular-nums text-muted-foreground" data-testid="docx-page-indicator" aria-live="polite">
        {#if phase === 'ready'}
          Page {current} of {pageCount}{pageLabels[current - 1] && pageLabels[current - 1] !== String(current) ? ` (numbered ${pageLabels[current - 1]})` : ''}
        {:else if phase === 'layout'}
          Laying out pages… {pageCount > 0 ? pageCount : ''}
        {:else if phase === 'loading'}
          Opening {name}…
        {/if}
      </span>
    {:else}
      <span class="text-muted-foreground" data-testid="docx-edit-mode" data-mode={lock.kind}>
        {lock.kind === 'editing' ? 'Editing' : lock.kind === 'starting' ? 'Starting to edit…' : lock.kind === 'locked' ? 'Read-only' : 'Edit layout — start typing to edit'}
      </span>
      {#if lock.kind === 'editing' || lock.kind === 'locked' || save.status !== 'saved' || save.savedAt}
        <span class="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="docx-save-state" data-status={save.status} aria-live="polite">
          {#if save.status === 'saving'}
            <LoaderIcon class="size-3.5 animate-spin" /> Saving…
          {:else if save.status === 'dirty'}
            Unsaved changes
          {:else if save.status === 'error'}
            <CircleAlertIcon class="size-3.5 text-destructive" /><span class="text-destructive" title={save.error ?? ''}>Couldn’t save</span>
            <Button size="sm" variant="outline" class="h-6 px-2 text-xs" onclick={() => autosave.retry()} data-testid="docx-save-retry">Retry</Button>
          {:else if save.status === 'lost'}
            Not saved — taken over
          {:else if save.savedAt}
            <CheckIcon class="size-3.5" /> Saved {fmtTime(save.savedAt)}
          {/if}
        </span>
      {/if}
    {/if}
    <div class="ms-auto flex items-center gap-1">
      {#if layout === 'print'}
        <Button variant="ghost" size="icon-sm" aria-label="Zoom out" onclick={() => zoomBy(-0.1)} disabled={phase === 'error'}>
          <ZoomOutIcon />
        </Button>
        <span class="w-12 text-center tabular-nums text-muted-foreground" data-testid="docx-zoom">{percent}%</span>
        <Button variant="ghost" size="icon-sm" aria-label="Zoom in" onclick={() => zoomBy(0.1)} disabled={phase === 'error'}>
          <ZoomInIcon />
        </Button>
        <Button
          variant={zoom === 'fit' ? 'secondary' : 'ghost'}
          size="sm"
          aria-pressed={zoom === 'fit'}
          onclick={() => {
            zoom = 'fit'
            measureFit()
          }}
          disabled={phase === 'error'}
          data-testid="docx-zoom-fit"
        >
          <MoveHorizontalIcon />
          Fit width
        </Button>
        <Button variant={zoom === 1 ? 'secondary' : 'ghost'} size="sm" aria-pressed={zoom === 1} onclick={() => (zoom = 1)} disabled={phase === 'error'} data-testid="docx-zoom-actual">
          100%
        </Button>
        {#if canEdit}
          <Button variant="outline" size="sm" onclick={startEdit} disabled={phase !== 'ready'} data-testid="docx-edit">
            <PencilIcon />
            Edit
          </Button>
        {/if}
      {:else}
        <Button variant="outline" size="sm" onclick={finishEdit} disabled={lock.kind === 'starting'} data-testid="docx-done">Done</Button>
      {/if}
    </div>
  </div>
  {#if lock.kind === 'locked'}
    <div class="flex flex-col gap-2 border-b border-destructive/40 bg-destructive/5 px-4 py-3 text-sm" role="alert" data-testid="docx-lock-banner">
      <div class="flex flex-wrap items-center gap-3">
        {#if lock.tookOver}<CircleAlertIcon class="size-4 text-destructive" />{:else}<LockIcon class="size-4 text-muted-foreground" />{/if}
        <span class="flex-1">
          {#if lock.tookOver}
            <strong data-testid="docx-lock-holder">{lock.holder?.name ?? 'Someone'}</strong> took over editing. This copy is read-only now.
          {:else}
            <strong data-testid="docx-lock-holder">{lock.holder?.name ?? 'Someone'}</strong> is editing this document. This copy is read-only.
          {/if}
        </span>
        <Button size="sm" variant="outline" onclick={() => startEditing(true)} data-testid="docx-takeover">{lock.tookOver ? 'Take it back' : 'Take over'}</Button>
      </div>
      {#if dirty}
        <div class="flex flex-wrap items-center gap-3">
          <span class="flex-1">Your changes were not saved. They stay on screen below; download them to keep them — taking over loads the saved version.</span>
          <Button size="sm" variant="outline" onclick={downloadDraft} data-testid="docx-download-draft"><DownloadIcon />Download my changes</Button>
        </div>
      {/if}
    </div>
  {/if}
  {#if lockError}<p class="border-b px-3 py-2 text-sm text-destructive" role="alert" data-testid="docx-lock-error">{lockError}</p>{/if}
  {#if notices.length > 0 && layout === 'print'}
    <ul class="flex flex-col gap-1 border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground" data-testid="docx-notices">
      {#each notices as notice (notice)}
        <li class="flex items-center gap-1.5"><InfoIcon class="size-3.5 shrink-0" />{notice}</li>
      {/each}
    </ul>
  {/if}
  {#if phase === 'error'}
    <p class="m-6 text-sm text-destructive" role="alert" data-testid="docx-error">
      This Word document could not be opened: {error}
    </p>
  {/if}
  {#if layout === 'edit' && session && editor && pmState}
    <EditToolbar {session} {editor} {pmState} disabled={readOnly} onlink={openLink} onimage={() => fileInput?.click()} />
    {#if linkOpen}
      <form class="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-sm" onsubmit={applyLink} data-testid="docx-link-form">
        <label class="text-xs text-muted-foreground" for="docx-link-target">Link to</label>
        <Input id="docx-link-target" class="h-7 max-w-md flex-1 text-xs" placeholder="https://… or #bookmark" bind:value={linkValue} data-testid="docx-link-input" />
        <Button size="sm" class="h-7 text-xs" type="submit" data-testid="docx-link-apply">Apply</Button>
        {#if pmState && linkAt(pmState)}
          <Button size="sm" variant="outline" class="h-7 text-xs" type="button" onclick={removeLink} data-testid="docx-link-remove">Remove link</Button>
        {/if}
        <Button size="sm" variant="ghost" class="h-7 text-xs" type="button" onclick={() => (linkOpen = false)}>Cancel</Button>
        {#if linkError}<span class="w-full text-xs text-destructive" role="alert">{linkError}</span>{/if}
      </form>
    {/if}
    {#if imageError}<p class="border-b px-3 py-1.5 text-xs text-destructive" role="alert" data-testid="docx-image-error">{imageError}</p>{/if}
  {/if}
  <input bind:this={fileInput} type="file" accept="image/png,image/jpeg,image/gif" class="hidden" onchange={onPicture} data-testid="docx-image-input" />
  <div
    bind:this={scroller}
    class="relative min-h-[75vh] flex-1 overflow-auto bg-muted/60"
    class:hidden={phase === 'error' || layout !== 'print'}
    onscroll={onScroll}
    data-testid="docx-scroller"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions (delegated: the links inside the pages are the interactive elements) -->
    <div
      bind:this={host}
      class="docx-pages flex w-max min-w-full flex-col gap-4 p-4"
      style:--docx-scale={scale}
      role="document"
      aria-label={name}
      aria-busy={phase !== 'ready'}
      onclick={onClick}
    ></div>
  </div>
  <div class="relative min-h-[75vh] flex-1 overflow-auto bg-muted/60 p-4" class:hidden={layout !== 'edit'} data-testid="docx-edit-scroller">
    <div
      class="docx-edit-page mx-auto bg-white text-black shadow-sm"
      class:opacity-90={readOnly}
      style:width="{sheet.widthPt}pt"
      style:max-width="100%"
      style:padding="{sheet.top}pt {sheet.right}pt {sheet.bottom}pt {sheet.left}pt"
      style:box-sizing="border-box"
      bind:this={editHost}
      data-testid="docx-edit-page"
    ></div>
  </div>
</div>

<style>
  /* The pages are built outside Svelte's markup (paginate.ts): only undo app-wide element styles inside them. */
  .docx-pages :global(.docx-page img) {
    max-width: none;
  }
  .docx-pages :global(.docx-page p) {
    hyphens: manual;
  }
  .docx-pages :global(.docx-page table) {
    caption-side: top;
  }
  .docx-pages :global(.docx-page a[href]) {
    cursor: pointer;
  }
  .docx-pages :global(.docx-page ::selection) {
    background: rgb(59 130 246 / 0.3);
  }
  /* The editor's continuous layout (ProseMirror builds it). */
  .docx-edit-page :global(.docx-edit-surface) {
    outline: none;
    white-space: pre-wrap;
    min-height: 50vh;
  }
  .docx-edit-page :global(.docx-edit-surface p) {
    hyphens: manual;
  }
  .docx-edit-page :global(.docx-edit-surface ::selection) {
    background: rgb(59 130 246 / 0.3);
  }
  .docx-edit-page :global(.docx-table td) {
    min-width: 2em;
  }
  .docx-edit-page :global(.docx-chip),
  .docx-edit-page :global(.docx-chip-block) {
    border: 1px dashed #9ca3af;
    background: #f3f4f6;
    color: #374151;
    border-radius: 3pt;
    padding: 0 3pt;
    font: 8.5pt/1.5 system-ui, sans-serif;
    text-indent: 0;
    user-select: none;
  }
  .docx-edit-page :global(.docx-chip-block) {
    display: block;
    margin: 4pt 0;
    padding: 2pt 6pt;
    white-space: normal;
  }
  .docx-edit-page :global(.docx-marker) {
    display: inline;
  }
  .docx-edit-page :global(.docx-page-break),
  .docx-edit-page :global(.docx-section-break) {
    display: block;
    margin: 6pt 0;
    border-top: 1px dashed #9ca3af;
    color: #6b7280;
    font: 8pt/1.6 system-ui, sans-serif;
    text-align: center;
    text-indent: 0;
    user-select: none;
  }
  .docx-edit-page :global(.ProseMirror-selectednode) {
    outline: 2px solid rgb(59 130 246 / 0.6);
  }
  .docx-edit-page :global(.ProseMirror-gapcursor) {
    display: none;
    pointer-events: none;
    position: absolute;
  }
  .docx-edit-page :global(.ProseMirror-focused .ProseMirror-gapcursor) {
    display: block;
  }
  .docx-edit-page :global(.ProseMirror-gapcursor::after) {
    content: '';
    display: block;
    position: absolute;
    top: -2px;
    width: 20px;
    border-top: 1px solid black;
  }
</style>
