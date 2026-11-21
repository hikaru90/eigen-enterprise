<script lang="ts">
  /* eslint-disable svelte/no-at-html-tags -- slide markup comes from ./render.ts, which escapes every value read from the file and only emits http(s)/mailto links and our own blob: image URLs */
  import type { OfficeViewerProps } from '../viewers'
  import type { Deck, Slide, SpNode } from './model'
  import CheckIcon from '@lucide/svelte/icons/check'
  import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left'
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right'
  import CircleAlertIcon from '@lucide/svelte/icons/circle-alert'
  import DownloadIcon from '@lucide/svelte/icons/download'
  import EllipsisIcon from '@lucide/svelte/icons/ellipsis'
  import EyeOffIcon from '@lucide/svelte/icons/eye-off'
  import LoaderIcon from '@lucide/svelte/icons/loader-circle'
  import LockIcon from '@lucide/svelte/icons/lock'
  import MessageSquareIcon from '@lucide/svelte/icons/message-square'
  import NotebookTextIcon from '@lucide/svelte/icons/notebook-text'
  import PencilIcon from '@lucide/svelte/icons/pencil'
  import PlusIcon from '@lucide/svelte/icons/plus'
  import PresentationIcon from '@lucide/svelte/icons/presentation'
  import XIcon from '@lucide/svelte/icons/x'
  import { onDestroy, onMount, tick, untrack } from 'svelte'
  import { beforeNavigate, goto } from '$app/navigation'
  import { Button } from '$lib/components/ui/button'
  import { driveApi, type LockHolder } from '$lib/drive/api'
  import { createAutosave, LockLostError, type Autosave, type AutosaveState } from '$lib/drive/autosave'
  import { createOfficeEditSession } from '../edit-session'
  import { OFFICE_MIME } from '../kinds'
  import { readPackage } from '../ooxml/package'
  import { markerSpots, openCount } from './comment-view'
  import CommentsPanel, { type PendingComment } from './comments-panel.svelte'
  import { frameOf, moveFrame, patchOf } from './edit-geometry'
  import EditToolbar, { type ToolbarState } from './edit-toolbar.svelte'
  import { createDeckEditor, type DeckEditor } from './editor'
  import { createMediaSource } from './media'
  import { effectiveXfrm, type Align, type DeckOp, type NewCommentAnchor, type OpResult, type RunFormat, type TextRange } from './ops'
  import { renderSlideSvg, type MediaSource } from './render'
  import { resolveSlide, type RParagraph, type RRun } from './resolve'
  import SlideOverlay, { type FrameChange, type OverlayItem } from './slide-overlay.svelte'
  import { readParagraphs, runPosOf, selectChars, selectionIn, textContainer, type CharPos } from './text-edit'

  /**
   * PowerPoint viewer and editor (plan/phase-office-files.md, S1 + S2).
   *
   * Viewing: the current slide large, a thumbnail rail, previous/next
   * (buttons, arrow keys, Page Up/Down, Home/End), the slide counter, speaker
   * notes, and presenter mode (full screen, keys or click to advance, Esc to
   * leave).
   *
   * Editing (when `canEdit`, after "Edit"): select shapes on the slide (click,
   * Shift for more, Esc to deselect), move them (drag, arrow keys), resize and
   * rotate them (handles), type into text in place (double-click), format
   * with the toolbar, insert text boxes and pictures, arrange, duplicate and
   * delete; reorder slides by dragging thumbnails, add (from a layout),
   * duplicate, delete and hide slides; edit the notes; undo/redo (⌘Z/⇧⌘Z).
   * Every change is an operation (./ops.ts) on the file itself. The edit lock
   * is taken with the first change (someone else editing: "X is editing",
   * Take over), changes save after a pause, the lock is let go after
   * `idleMs` without a change, and when someone takes over the work stays on
   * screen (with a download of it) and says who did. Leaving saves first.
   *
   * Comments (S3): markers on the slide for open threads, counts on the
   * thumbnails, and a comments panel (this slide / all slides) with threads,
   * replies, resolve/reopen, and editing or deleting your own. New comments
   * go on the slide, the selected shape, or a point clicked on the slide.
   * `author` (the signed-in member) is who writes them; without it, or
   * without edit access, commenting is off and the panel says why. A comment
   * is a change like any other: it takes the lock, saves, and undoes.
   */
  let { fileId, name, canEdit, heartbeatMs, author, onsaved, saveDelayMs = 1200, idleMs = 60_000 }: OfficeViewerProps & { saveDelayMs?: number; idleMs?: number } = $props()

  type View = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; deck: Deck }
  // Raw: the deck is plain data with source links keyed by object identity; no deep proxy.
  let view = $state.raw<View>({ status: 'loading' })
  let current = $state(0)
  let showNotes = $state(true)
  let presenting = $state(false)
  let fullscreenRefused = $state(false)
  let thumbsShown = $state<Record<string, boolean>>({})
  let rootEl = $state<HTMLDivElement | null>(null)
  let railEl = $state<HTMLOListElement | null>(null)
  let presenterEl = $state<HTMLDivElement | null>(null)
  let slideEl = $state<HTMLDivElement | null>(null)
  let notesEl = $state<HTMLTextAreaElement | null>(null)

  let media: MediaSource = () => null
  let forgetMedia: (part: string) => void = () => {}
  let disposeMedia = () => {}
  let wentFullscreen = false
  /** Drawn slides by place, part, position and edit count: a plain cache, not view state. */
  let drawn: Record<string, { svg: string } | { error: string }> = {}
  /** Edits per part (a changed slide draws again). */
  let partRev: Record<string, number> = {}

  // -------------------------------------------------------------------------
  // Editing state

  type Mode = { kind: 'viewing' } | { kind: 'editing' } | { kind: 'watching'; holder: LockHolder } | { kind: 'lost'; holder: LockHolder | null }
  let mode = $state<Mode>({ kind: 'viewing' })
  let locking = $state(false)
  let held = $state(false)
  let save = $state<AutosaveState>({ status: 'saved', error: null, savedAt: null })
  let notice = $state<string | null>(null)
  /** Bumped on every change: what history buttons and the toolbar read. */
  let rev = $state(0)
  let selected = $state<string[]>([])
  /** The shape whose text is being typed into. */
  let typing = $state<string | null>(null)
  /** The text selection while typing (character positions), for the toolbar. */
  let liveSel = $state<{ start: CharPos; end: CharPos } | null>(null)
  let menuFor = $state<number | null>(null)
  let layoutMenu = $state<'rail' | number | null>(null)
  let dragFrom = $state<number | null>(null)
  let dropAt = $state<number | null>(null)
  let showComments = $state(false)
  /** The thread picked (a marker, a jump from "All slides", one just written). */
  let focusedComment = $state<string | null>(null)
  /** A new comment waiting for its text: where it goes. */
  let pending = $state<(PendingComment & { anchor: NewCommentAnchor; pos: { x: number; y: number } | null }) | null>(null)
  /** Waiting for a click on the slide, where a new comment goes. */
  let placing = $state(false)

  let editor: DeckEditor | null = null
  /** The file's bytes as the server has them (last loaded or saved). */
  let base: Uint8Array | null = null
  let lostHolder: LockHolder | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let lockWait: Promise<boolean> | null = null
  let textRoot: HTMLElement | null = null
  /** The text selection when typing ended because a toolbar field took the focus (size, colour). */
  let afterBlur: { id: string; sel: { start: CharPos; end: CharPos } | null } | null = null

  const session = createOfficeEditSession({ fileId: untrack(() => fileId), heartbeatMs: untrack(() => heartbeatMs), onLost: (holder) => lose(holder) })
  let autosave: Autosave = makeAutosave()

  function makeAutosave(): Autosave {
    return createAutosave({
      delayMs: untrack(() => saveDelayMs),
      onState: (s) => (save = s),
      onLost: () => lose(lostHolder),
      async save() {
        const bytes = editor!.toBytes()
        try {
          const file = await session.save(bytes)
          base = bytes
          onsaved?.(file)
        } catch (err) {
          if (err instanceof LockLostError) held = false
          throw err
        }
      },
    })
  }

  const deck = $derived(view.status === 'ready' ? view.deck : null)
  const count = $derived(deck?.slides.length ?? 0)
  const slide = $derived<Slide | null>(deck?.slides[current] ?? null)
  const aspect = $derived(deck ? deck.size.cx / deck.size.cy : 16 / 9)
  const editing = $derived(mode.kind === 'editing')
  const slideW = $derived(deck ? deck.size.cx / 9525 : 1280)
  const slideH = $derived(deck ? deck.size.cy / 9525 : 720)
  const notesText = $derived(
    (slide?.notes?.paragraphs ?? [])
      .map((p) =>
        p.runs
          .map((r) => (r.kind === 'break' ? '\n' : r.kind === 'field' && r.type === 'slidenum' ? String(slide!.number) : r.text))
          .join(''),
      )
      .join('\n'),
  )
  const notes = $derived(notesText.split('\n').filter((t) => t.trim() !== ''))

  /** The shapes of the current slide that can be picked (top level, placed, with a unique id). */
  const items = $derived.by<OverlayItem[]>(() => {
    if (!deck || !slide || !editing) return []
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- id counts while listing the pickable shapes, never rendered
    const counts = new Map<string, number>()
    for (const s of slide.shapes) counts.set(s.id, (counts.get(s.id) ?? 0) + 1)
    return slide.shapes.flatMap((s) => {
      if (s.hidden || s.kind === 'other' || !s.id || counts.get(s.id)! > 1) return []
      const x = effectiveXfrm(deck, slide, s)
      if (!x) return []
      const text = s.kind === 'sp' && !s.connector && s.text !== null
      const empty = text && s.ph !== null && (s as SpNode).text!.paragraphs.every((p) => p.runs.every((r) => r.kind !== 'break' && r.text === ''))
      const what = s.kind === 'pic' ? 'Picture' : s.kind === 'group' ? 'Group' : s.kind === 'frame' ? 'Frame' : 'Shape'
      return [{ id: s.id, name: s.name || what, frame: frameOf(x), text, empty, resizable: !(s.kind === 'frame' && s.content.kind === 'table'), rotatable: s.kind !== 'frame' }]
    })
  })
  const history = $derived.by(() => {
    void rev
    return { undo: editor?.canUndo() ?? false, redo: editor?.canRedo() ?? false }
  })
  const textIds = $derived(selected.filter((id) => items.find((i) => i.id === id)?.text))
  /** The current slide resolved for editing (toolbar state reads its text). */
  const resolvedMain = $derived.by(() => {
    if (!deck || !editing || !slide) return null
    try {
      return resolveSlide(deck, current, { editing: true })
    } catch {
      // Drawing shows the error; the toolbar just has nothing to read.
      return null
    }
  })
  const toolbar = $derived.by<ToolbarState>(() => {
    void rev
    const paras: RParagraph[] = []
    const runs: RRun[] = []
    const nodes = resolvedMain ? resolvedMain.nodes.slice(resolvedMain.ownStart) : []
    const ids = typing ? [typing] : textIds
    for (const id of ids) {
      const node = nodes.find((n) => n.id === id)
      const ps = node?.kind === 'shape' ? (node.text?.paragraphs ?? []) : []
      if (typing && liveSel) {
        const picked = runsIn(ps, liveSel)
        paras.push(...picked.paras)
        runs.push(...picked.runs)
      } else {
        paras.push(...ps)
        runs.push(...ps.flatMap((p) => p.runs.filter((r) => !r.isBreak && r.text)))
      }
    }
    const every = (f: (r: RRun) => boolean) => runs.length > 0 && runs.every(f)
    const one = <T,>(vals: T[]): T | null => (vals.length && vals.every((v) => v === vals[0]) ? vals[0]! : null)
    return {
      bold: every((r) => r.bold),
      italic: every((r) => r.italic),
      underline: every((r) => r.underline !== null),
      size: one(runs.map((r) => Math.round(r.size * 0.75 * 2) / 2)),
      color: one(runs.map((r) => (r.fill.kind === 'solid' ? hex(r.fill.color) : null))),
      align: one(paras.map((p) => (['l', 'ctr', 'r', 'just'].includes(p.align) ? (p.align as Align) : null))),
      bullets: paras.length > 0 && paras.filter((p) => p.runs.some((r) => r.text)).every((p) => p.bullet !== null) && paras.some((p) => p.runs.some((r) => r.text)),
    }
  })

  function hex(c: { r: number; g: number; b: number }): string {
    return [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()
  }

  /** The paragraphs and runs a character selection touches (a caret: the run before it). */
  function runsIn(ps: RParagraph[], sel: { start: CharPos; end: CharPos }): { paras: RParagraph[]; runs: RRun[] } {
    const paras = ps.slice(sel.start.p, sel.end.p + 1)
    const runs: RRun[] = []
    const collapsed = sel.start.p === sel.end.p && sel.start.c === sel.end.c
    ps.forEach((p, pi) => {
      if (pi < sel.start.p || pi > sel.end.p) return
      let c = 0
      for (const r of p.runs) {
        const len = r.isBreak ? 1 : r.text.length
        const from = pi === sel.start.p ? sel.start.c : 0
        const to = pi === sel.end.p ? sel.end.c : Infinity
        const hit = collapsed ? c < from && from <= c + len : c < to && c + len > from
        if (hit && !r.isBreak && r.text) runs.push(r)
        c += len
      }
    })
    return { paras, runs }
  }

  onMount(() => {
    void load()
    document.addEventListener('fullscreenchange', onFullscreenChange)
    document.addEventListener('selectionchange', onSelectionChange)
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (mode.kind !== 'editing') return
      commitText()
      if (autosave.unsaved() === null && save.status !== 'saving') return
      void autosave.flush()
      event.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange)
      document.removeEventListener('selectionchange', onSelectionChange)
      window.removeEventListener('beforeunload', onBeforeUnload)
      clearIdle()
      if (mode.kind === 'editing') {
        commitPending()
        void autosave.flush().then(() => session.stop())
      }
    }
  })
  onDestroy(() => disposeMedia())

  // In-app navigation waits for the last save, then continues.
  let leaving = false
  beforeNavigate((nav) => {
    if (leaving || mode.kind !== 'editing') return
    commitPending()
    if (autosave.unsaved() === null && save.status !== 'saving') return
    const to = nav.to?.url
    if (nav.type === 'leave' || !to || nav.type === 'popstate') {
      void autosave.flush()
      return
    }
    nav.cancel()
    leaving = true
    void autosave.flush().then(async () => {
      try {
        if (save.status === 'error' && !confirm('Your latest changes could not be saved. Leave anyway and lose them?')) return
        // The navigation the person already started (an app URL SvelteKit resolved).
        // eslint-disable-next-line svelte/no-navigation-without-resolve
        await goto(to.href, { invalidateAll: true })
      } finally {
        leaving = false
      }
    })
  })

  async function load() {
    try {
      open(await driveApi.readBytes(fileId))
      rootEl?.focus({ preventScroll: true })
    } catch (err) {
      view = { status: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Opens bytes as the deck on screen (first load, reload after someone else's save, take over). */
  function open(bytes: Uint8Array) {
    const next = createDeckEditor(readPackage(bytes))
    disposeMedia()
    const source = createMediaSource(next.pkg)
    media = source.media
    forgetMedia = source.forget
    disposeMedia = source.dispose
    editor = next
    base = bytes
    drawn = {}
    partRev = {}
    selected = []
    typing = null
    textRoot = null
    view = { status: 'ready', deck: next.deck() }
    current = Math.min(current, Math.max(0, next.deck().slides.length - 1))
    rev++
  }

  /** One slide's SVG for a place on the page (main, thumbnail, presenter), drawn once per version. */
  function draw(index: number, place: 'main' | 'thumb' | 'show'): { svg: string } | { error: string } {
    const s = deck!.slides[index]!
    const forEdit = place === 'main' && editing
    const key = `${place}:${s.part}:${index}:${partRev[s.part] ?? 0}:${forEdit ? 'e' : ''}`
    const hit = drawn[key]
    if (hit) return hit
    let out: { svg: string } | { error: string }
    try {
      out = { svg: renderSlideSvg(resolveSlide(deck!, index, { editing: forEdit }), { idPrefix: `pptx-${place}-${index}`, media, links: place !== 'thumb' && !forEdit }) }
    } catch (err) {
      out = { error: err instanceof Error ? err.message : String(err) }
    }
    drawn[key] = out
    return out
  }

  async function go(index: number) {
    if (!deck || count === 0) return
    commitPending()
    if (index !== current) {
      pending = null
      placing = false
    }
    current =Math.max(0, Math.min(count - 1, index))
    selected = []
    menuFor = null
    await tick()
    railEl?.querySelector(`[data-thumb="${current}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }

  /** The next slide in this direction; presenter mode skips hidden slides. */
  function step(dir: 1 | -1) {
    if (!deck) return
    let i = current + dir
    while (presenting && i >= 0 && i < count && deck.slides[i]!.hidden) i += dir
    if (i >= 0 && i < count) void go(i)
  }

  function edge(to: 'first' | 'last') {
    if (!deck) return
    const order = deck.slides.map((_, i) => i)
    if (to === 'last') order.reverse()
    const i = order.find((k) => !presenting || !deck.slides[k]!.hidden)
    if (i !== undefined) void go(i)
  }

  const isTypingTarget = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable)

  function onEditKeys(event: KeyboardEvent): boolean {
    const mod = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    if (mod && key === 'z') {
      void (event.shiftKey ? redo() : undo())
      return true
    }
    if (mod && key === 'y') {
      void redo()
      return true
    }
    if (mod && key === 'd' && selected.length) {
      void duplicate()
      return true
    }
    if (mod || event.altKey || selected.length === 0) return false
    const nudge = event.shiftKey ? 10 : 1
    switch (event.key) {
      case 'ArrowLeft':
        void move(-nudge, 0)
        return true
      case 'ArrowRight':
        void move(nudge, 0)
        return true
      case 'ArrowUp':
        void move(0, -nudge)
        return true
      case 'ArrowDown':
        void move(0, nudge)
        return true
      case 'Delete':
      case 'Backspace':
        void remove()
        return true
      case 'Escape':
        selected = []
        return true
      case 'Enter':
        if (textIds.length === 1 && selected.length === 1) {
          void beginText(textIds[0]!, 'end')
          return true
        }
        return false
      default:
        return false
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (!deck || event.defaultPrevented) return
    const target = event.target
    if (isTypingTarget(target)) return
    if (editing && !presenting && onEditKeys(event)) {
      event.preventDefault()
      return
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const link = target instanceof Element ? target.closest('[data-slide-link]') : null
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
      case 'PageDown':
        step(1)
        break
      case ' ':
        if (target instanceof HTMLButtonElement && !presenting) return
        step(1)
        break
      case 'ArrowLeft':
      case 'ArrowUp':
      case 'PageUp':
        step(-1)
        break
      case 'Home':
        edge('first')
        break
      case 'End':
        edge('last')
        break
      case 'Enter':
        if (!link) return
        void go(Number(link.getAttribute('data-slide-link')))
        break
      case 'Escape':
        if (placing) {
          placing = false
          break
        }
        if (menuFor !== null || layoutMenu !== null) {
          menuFor = null
          layoutMenu = null
          break
        }
        if (!presenting) return
        void stopPresenting()
        break
      default:
        return
    }
    event.preventDefault()
  }

  /** Clicks on a slide link (a jump to another slide inside the deck). */
  function onSlideClick(event: MouseEvent) {
    if (editing) return
    const link = event.target instanceof Element ? event.target.closest('[data-slide-link]') : null
    if (!link) return
    event.preventDefault()
    void go(Number(link.getAttribute('data-slide-link')))
  }

  function onPresenterClick(event: MouseEvent) {
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('a[href]') || target?.closest('button')) return
    const link = target?.closest('[data-slide-link]')
    if (link) void go(Number(link.getAttribute('data-slide-link')))
    else step(1)
  }

  async function present() {
    if (!deck) return
    commitPending()
    if (deck.slides[current]?.hidden) {
      const next = deck.slides.findIndex((s, i) => i >= current && !s.hidden)
      if (next >= 0) current = next
    }
    presenting = true
    fullscreenRefused = false
    await tick()
    presenterEl?.focus()
    if (!presenterEl?.requestFullscreen) {
      fullscreenRefused = true
      return
    }
    try {
      await presenterEl.requestFullscreen()
      wentFullscreen = true
    } catch {
      // The browser refused full screen (policy or no user gesture): presenting stays in the window, and says so.
      fullscreenRefused = true
    }
  }

  async function stopPresenting() {
    presenting = false
    if (document.fullscreenElement) {
      wentFullscreen = false
      await document.exitFullscreen()
    }
    await tick()
    rootEl?.focus({ preventScroll: true })
  }

  function onFullscreenChange() {
    // Leaving full screen (Esc handled by the browser, F11 …) ends presenting too.
    if (!document.fullscreenElement && wentFullscreen) {
      wentFullscreen = false
      if (presenting) void stopPresenting()
    }
  }

  /** Thumbnails draw when they come near the rail's visible area. */
  function whenVisible(part: string) {
    return (node: HTMLElement) => {
      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            thumbsShown[part] = true
            io.disconnect()
          }
        },
        { rootMargin: '300px' },
      )
      io.observe(node)
      return () => io.disconnect()
    }
  }

  // -------------------------------------------------------------------------
  // The edit lock and saving

  const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

  function sameBytes(x: Uint8Array, y: Uint8Array) {
    if (x.length !== y.length) return false
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
    return true
  }

  function startEditing() {
    notice = null
    mode = { kind: 'editing' }
  }

  /** The lock before a change: taken on the first one (and again after an idle release). */
  async function ensureLock(): Promise<boolean> {
    if (mode.kind !== 'editing') return false
    if (session.held()) return true
    lockWait ??= (async () => {
      locking = true
      try {
        const view = await session.start()
        if (view.state === 'held') {
          held = true
          // Someone may have saved since this copy was loaded: never save over that.
          const now = await driveApi.readBytes(fileId)
          if (base && !sameBytes(now, base)) {
            open(now)
            notice = 'Someone saved a newer version of this presentation, so it was reloaded. Make your change again.'
            return false
          }
          return true
        }
        if (view.state === 'locked') {
          endTypingWithoutSaving()
          selected = []
          mode = { kind: 'watching', holder: view.holder }
          return false
        }
        notice = 'The presentation could not be opened for editing. Try again.'
        return false
      } catch (err) {
        notice = message(err)
        return false
      } finally {
        locking = false
        lockWait = null
      }
    })()
    return lockWait
  }

  /** Someone took over: the work stays on screen, read-only, and nothing more is saved. */
  function lose(holder: LockHolder | null) {
    lostHolder = holder ?? lostHolder
    held = false
    if (mode.kind === 'lost') return
    clearIdle()
    autosave.stop()
    if (typing && textRoot && editor) {
      // Keep what was typed in the copy on screen (and in the download).
      const r = applyLocal({ kind: 'setText', slide: slide!.part, shape: typing, paragraphs: readParagraphs(textRoot) })
      if (r) changed(r, false)
    }
    typing = null
    textRoot = null
    selected = []
    mode = { kind: 'lost', holder: lostHolder }
  }

  /** Take over (someone else edits) or take it back (after losing it): the newest saved copy, then editing. */
  async function takeOver() {
    notice = null
    locking = true
    try {
      const view = await session.start({ takeover: true })
      if (view.state !== 'held') {
        notice = 'The presentation could not be opened for editing. Try again.'
        return
      }
      held = true
      lostHolder = null
      open(await driveApi.readBytes(fileId))
      autosave = makeAutosave()
      save = autosave.state()
      mode = { kind: 'editing' }
      touchIdle()
    } catch (err) {
      notice = message(err)
    } finally {
      locking = false
    }
  }

  /** Done: save what is left, let the lock go, back to viewing. */
  async function stopEditing() {
    commitPending()
    clearIdle()
    await autosave.flush()
    if (save.status === 'error') {
      notice = 'Your latest changes could not be saved yet. Retry, or keep editing.'
      return
    }
    if (mode.kind !== 'editing') return
    selected = []
    mode = { kind: 'viewing' }
    held = false
    await session.stop()
  }

  function clearIdle() {
    if (idleTimer !== null) clearTimeout(idleTimer)
    idleTimer = null
  }
  function touchIdle() {
    clearIdle()
    idleTimer = setTimeout(() => void idleRelease(), idleMs)
  }
  /** A quiet spell: everything saved, the lock goes back (the next change takes it again). */
  async function idleRelease() {
    idleTimer = null
    if (mode.kind !== 'editing' || !session.held()) return
    if (typing) return touchIdle()
    await autosave.flush()
    if (mode.kind !== 'editing' || autosave.unsaved() !== null || save.status !== 'saved') return touchIdle()
    held = false
    await session.stop()
  }

  function downloadCopy() {
    if (!editor) return
    const url = URL.createObjectURL(new Blob([editor.toBytes().slice().buffer as ArrayBuffer], { type: OFFICE_MIME.pptx }))
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  // -------------------------------------------------------------------------
  // Changes

  function applyLocal(op: DeckOp): OpResult | null {
    if (!editor) return null
    try {
      return editor.apply(op)
    } catch (err) {
      notice = message(err)
      return null
    }
  }

  /** After a change: redraw what it touched, keep the selection to what is still there, save. */
  function changed(r: OpResult, persist = true) {
    for (const part of r.touched) {
      partRev[part] = (partRev[part] ?? 0) + 1
      forgetMedia(part)
    }
    const next = editor!.deck()
    view = { status: 'ready', deck: next }
    current = Math.max(0, Math.min(current, next.slides.length - 1))
    const ids = new Set(next.slides[current]?.shapes.map((s) => s.id) ?? [])
    selected = selected.filter((id) => ids.has(id))
    rev++
    if (persist && mode.kind === 'editing') {
      autosave.change(String(editor!.version()))
      touchIdle()
    }
  }

  /** Applies a change under the edit lock. */
  async function change(op: DeckOp): Promise<OpResult | null> {
    if (!(await ensureLock())) return null
    notice = null
    const r = applyLocal(op)
    if (r) changed(r)
    return r
  }

  async function undo() {
    commitPending()
    if (!editor?.canUndo() || !(await ensureLock())) return
    const r = runHistory(() => editor!.undo())
    if (r) changed(r)
  }
  async function redo() {
    commitPending()
    if (!editor?.canRedo() || !(await ensureLock())) return
    const r = runHistory(() => editor!.redo())
    if (r) changed(r)
  }
  function runHistory(fn: () => OpResult | null): OpResult | null {
    try {
      return fn()
    } catch (err) {
      notice = message(err)
      return null
    }
  }

  const batch = (ops: DeckOp[]): DeckOp => (ops.length === 1 ? ops[0]! : { kind: 'batch', ops })

  function select(ids: string[]) {
    afterBlur = null
    menuFor = null
    selected = ids
  }

  async function commitFrames(changes: FrameChange[]) {
    if (!slide) return
    const part = slide.part
    const ops = changes.flatMap((c): DeckOp[] => {
      const xfrm = patchOf(c.from, c.to)
      return Object.keys(xfrm).length ? [{ kind: 'setXfrm', slide: part, shape: c.id, xfrm }] : []
    })
    if (ops.length) await change(batch(ops))
  }

  async function move(dx: number, dy: number) {
    const frames = selected.flatMap((id) => {
      const f = items.find((i) => i.id === id)?.frame
      return f ? [{ id, from: f, to: moveFrame(f, dx, dy) }] : []
    })
    await commitFrames(frames)
  }

  async function remove() {
    if (!slide || !selected.length) return
    const part = slide.part
    const r = await change(batch(selected.map((id): DeckOp => ({ kind: 'deleteShape', slide: part, shape: id }))))
    if (r) selected = []
  }

  async function duplicate() {
    if (!slide || !selected.length) return
    const part = slide.part
    const before = new Set(slide.shapes.map((s) => s.id))
    const r = await change(batch(selected.map((id): DeckOp => ({ kind: 'duplicateShape', slide: part, shape: id }))))
    if (r) selected = (deck?.slides[current]?.shapes ?? []).filter((s) => !before.has(s.id)).map((s) => s.id)
  }

  async function arrange(dir: 'forward' | 'backward') {
    if (!slide || !selected.length) return
    const part = slide.part
    const order = slide.shapes.map((s) => s.id).filter((id) => selected.includes(id))
    // Moving forward, the frontmost goes first (so the selection keeps its own order).
    if (dir === 'forward') order.reverse()
    await change(batch(order.map((id): DeckOp => ({ kind: 'arrange', slide: part, shape: id, dir }))))
  }

  async function insertText() {
    if (!deck || !slide) return
    const cx = Math.round(deck.size.cx * 0.4)
    const cy = Math.round(deck.size.cy * 0.12)
    const r = await change({ kind: 'insertTextBox', slide: slide.part, box: { x: Math.round((deck.size.cx - cx) / 2), y: Math.round((deck.size.cy - cy) / 2), cx, cy }, text: 'Text' })
    const id = r?.created?.shape
    if (id) {
      selected = [id]
      await beginText(id, 'all')
    }
  }

  async function insertPicture(file: File) {
    if (!slide) return
    const part = slide.part
    const bytes = new Uint8Array(await file.arrayBuffer())
    const r = await change({ kind: 'insertPicture', slide: part, bytes, contentType: file.type, name: file.name.replace(/\.[^.]+$/, '') })
    if (r?.created?.shape) selected = [r.created.shape]
  }

  // -------------------------------------------------------------------------
  // Text in place

  function shapeEl(id: string): Element | null {
    return slideEl?.querySelector(`[data-sid="${CSS.escape(id)}"]`) ?? null
  }

  /** Starts typing into a shape's text (`select`: where the caret goes). */
  async function beginText(id: string, select: 'all' | 'end' | { start: CharPos; end: CharPos }) {
    if (!(await ensureLock())) return
    afterBlur = null
    selected = [id]
    await tick()
    const box = shapeEl(id)?.querySelector('.pptx-text')
    const root = box ? textContainer(box) : null
    if (!root) {
      notice = 'This shape has no text to edit.'
      return
    }
    typing = id
    textRoot = root
    root.contentEditable = 'true'
    root.spellcheck = true
    root.setAttribute('role', 'textbox')
    root.setAttribute('aria-multiline', 'true')
    root.setAttribute('aria-label', `Text of ${items.find((i) => i.id === id)?.name ?? 'the shape'}`)
    root.dataset.testid = 'pptx-text-editor'
    root.style.outline = 'none'
    root.style.cursor = 'text'
    for (const b of root.querySelectorAll<HTMLElement>('.pptx-bullet')) b.contentEditable = 'false'
    root.addEventListener('keydown', onTextKeydown)
    root.addEventListener('input', touchIdle)
    root.addEventListener('paste', onTextPaste)
    root.addEventListener('blur', onTextBlur)
    root.focus()
    const ps = readParagraphs(root)
    const endPos = { p: ps.length - 1, c: ps.at(-1)!.runs.reduce((n, r) => n + (r.kind === 'break' ? 1 : r.text.length), 0) }
    if (select === 'all') selectChars(root, { p: 0, c: 0 }, endPos)
    else if (select === 'end') selectChars(root, endPos, endPos)
    else selectChars(root, select.start, select.end)
    liveSel = selectionIn(root)
  }

  function unwire(root: HTMLElement) {
    root.removeEventListener('keydown', onTextKeydown)
    root.removeEventListener('input', touchIdle)
    root.removeEventListener('paste', onTextPaste)
    root.removeEventListener('blur', onTextBlur)
    root.removeAttribute('contenteditable')
  }

  /** Commits what was typed (an operation), without ending the typing. */
  function commitText() {
    if (!typing || !textRoot || !slide || !session.held()) return
    const r = applyLocal({ kind: 'setText', slide: slide.part, shape: typing, paragraphs: readParagraphs(textRoot) })
    if (r) changed(r)
  }

  function endText() {
    const root = textRoot
    commitText()
    if (root) unwire(root)
    typing = null
    textRoot = null
    liveSel = null
  }

  function endTypingWithoutSaving() {
    if (textRoot) unwire(textRoot)
    typing = null
    textRoot = null
    liveSel = null
  }

  /** Pending edits (typing, notes) become operations before anything else happens. */
  function commitPending() {
    if (typing) endText()
    if (notesEl && document.activeElement === notesEl) commitNotes(notesEl.value)
  }

  function onTextKeydown(e: KeyboardEvent) {
    // Typing keys stay in the text (undo inside it is the browser's own).
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      const id = typing
      endText()
      if (id) selected = [id]
      rootEl?.focus({ preventScroll: true })
    }
  }

  function onTextPaste(e: ClipboardEvent) {
    // Plain text only: pasted markup would bring formatting the file can't hold.
    e.preventDefault()
    const text = e.clipboardData?.getData('text/plain') ?? ''
    document.execCommand('insertText', false, text)
  }

  function onTextBlur(e: FocusEvent) {
    const id = typing
    const sel = liveSel
    const to = e.relatedTarget
    endText()
    if (id && to instanceof Element && to.closest('[data-pptx-toolbar]')) afterBlur = { id, sel }
  }

  function onSelectionChange() {
    if (textRoot) liveSel = selectionIn(textRoot)
  }

  /** The text a toolbar action applies to: what is being typed into (its selection), or the selected shapes. */
  function textTarget(): { id: string; sel: { start: CharPos; end: CharPos } | null } | null {
    if (typing && textRoot) return { id: typing, sel: selectionIn(textRoot) }
    if (afterBlur && selected.includes(afterBlur.id)) return afterBlur
    return null
  }

  const collapsed = (s: { start: CharPos; end: CharPos } | null) => !s || (s.start.p === s.end.p && s.start.c === s.end.c)

  async function format(f: RunFormat) {
    if (!slide) return
    const t = textTarget()
    if (t) {
      if (typing) endText()
      const node = deck!.slides[current]!.shapes.find((s) => s.id === t.id) as SpNode | undefined
      const ps = node?.text?.paragraphs ?? []
      // A caret (no selection) formats the whole text, like the selected shape.
      const range: TextRange | null = collapsed(t.sel) ? null : { start: runPosOf(ps, t.sel!.start, slide.number), end: runPosOf(ps, t.sel!.end, slide.number) }
      await change({ kind: 'formatRuns', slide: slide.part, shape: t.id, range, format: f })
      await beginText(t.id, t.sel ?? 'end')
      return
    }
    const part = slide.part
    if (textIds.length) await change(batch(textIds.map((id): DeckOp => ({ kind: 'formatRuns', slide: part, shape: id, range: null, format: f }))))
  }

  async function paragraphs(patch: { align?: Align; bullets?: boolean }) {
    if (!slide) return
    const part = slide.part
    const t = textTarget()
    if (t) {
      if (typing) endText()
      const picked = t.sel ? Array.from({ length: t.sel.end.p - t.sel.start.p + 1 }, (_, i) => t.sel!.start.p + i) : null
      await change({ kind: 'formatParagraphs', slide: part, shape: t.id, paragraphs: picked, ...patch })
      await beginText(t.id, t.sel ?? 'end')
      return
    }
    if (textIds.length) await change(batch(textIds.map((id): DeckOp => ({ kind: 'formatParagraphs', slide: part, shape: id, paragraphs: null, ...patch }))))
  }

  // -------------------------------------------------------------------------
  // Notes

  async function onNotesFocus() {
    if (!(await ensureLock())) notesEl?.blur()
  }

  function commitNotes(text: string) {
    if (!slide || text === notesText || !session.held()) return
    const r = applyLocal({ kind: 'setNotes', slide: slide.part, text })
    if (r) changed(r)
  }

  // -------------------------------------------------------------------------
  // Slides

  const layoutsHere = $derived.by(() => {
    if (!deck) return []
    const layout = deck.layouts[slide?.layout ?? deck.slides[0]?.layout ?? '']
    const master = layout ? deck.masters[layout.master] : Object.values(deck.masters)[0]
    return (master?.layouts ?? []).map((part) => ({ part, name: deck.layouts[part]?.name || 'Layout' }))
  })

  async function addSlide(layout: string, at: number) {
    layoutMenu = null
    menuFor = null
    const r = await change({ kind: 'addSlide', layout, at })
    if (r) await go(at)
  }

  async function slideAction(i: number, action: 'duplicate' | 'delete' | 'hide' | 'up' | 'down') {
    menuFor = null
    const s = deck?.slides[i]
    if (!s) return
    commitPending()
    switch (action) {
      case 'duplicate':
        if (await change({ kind: 'duplicateSlide', slide: s.part })) await go(i + 1)
        break
      case 'delete':
        if (await change({ kind: 'deleteSlide', slide: s.part })) await go(Math.min(i, count - 1))
        break
      case 'hide':
        await change({ kind: 'setHidden', slide: s.part, hidden: !s.hidden })
        break
      case 'up':
      case 'down': {
        const to = action === 'up' ? i - 1 : i + 1
        if (to < 0 || to >= count) return
        if (await change({ kind: 'moveSlide', slide: s.part, to })) await go(to)
        break
      }
    }
  }

  function onDragStart(e: DragEvent, i: number) {
    if (!editing) return
    dragFrom = i
    e.dataTransfer?.setData('text/plain', String(i))
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  }
  function onDragOver(e: DragEvent, i: number) {
    if (dragFrom === null) return
    e.preventDefault()
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
    dropAt = e.clientY > box.top + box.height / 2 ? i + 1 : i
  }
  async function onDrop(e: DragEvent) {
    e.preventDefault()
    const from = dragFrom
    const at = dropAt
    dragFrom = null
    dropAt = null
    if (from === null || at === null || !deck) return
    const to = at > from ? at - 1 : at
    if (to === from) return
    const part = deck.slides[from]!.part
    if (await change({ kind: 'moveSlide', slide: part, to })) await go(to)
  }

  function closeMenuOutside(e: FocusEvent) {
    const next = e.relatedTarget
    if (!(next instanceof Node) || !(e.currentTarget as HTMLElement).contains(next)) {
      menuFor = null
      if (layoutMenu !== 'rail') layoutMenu = null
    }
  }

  // -------------------------------------------------------------------------
  // Comments

  const markers = $derived(deck && slide ? markerSpots(deck, slide) : [])
  const commentsOff = $derived.by<string | null>(() => {
    if (!author) return 'Commenting is off here: who is signed in is not known to this viewer.'
    if (!canEdit) return 'You can read the comments. Adding them needs edit access to this file.'
    if (mode.kind === 'watching') return `${mode.holder.name} is editing. You can comment once they are done, or after taking over.`
    if (mode.kind === 'lost') return 'Someone else took over editing, so comments are read-only in your copy.'
    return null
  })
  const canComment = $derived(commentsOff === null)
  const selectedShape = $derived.by(() => {
    if (selected.length !== 1) return null
    const item = items.find((i) => i.id === selected[0])
    return item ? { id: item.id, name: item.name } : null
  })
  const guid = () => `{${crypto.randomUUID().toUpperCase()}}`

  /** A comment change: editing starts if it has not, then it is a change like any other. */
  async function commentChange(op: DeckOp): Promise<boolean> {
    if (!canComment) return false
    if (mode.kind === 'viewing') startEditing()
    commitPending()
    return (await change(op)) !== null
  }

  function startComment(where: 'slide' | 'shape' | 'point') {
    focusedComment = null
    if (where === 'point') {
      pending = null
      placing = true
      return
    }
    placing = false
    if (where === 'shape' && selectedShape) pending = { anchor: { kind: 'shape', shape: selectedShape.id }, pos: null, label: `On “${selectedShape.name}”` }
    else pending = { anchor: { kind: 'slide' }, pos: null, label: 'On this slide' }
  }

  function placeAt(e: MouseEvent) {
    if (!deck || !slideEl) return
    e.preventDefault()
    e.stopPropagation()
    const box = slideEl.getBoundingClientRect()
    const x = Math.round(((e.clientX - box.left) / box.width) * deck.size.cx)
    const y = Math.round(((e.clientY - box.top) / box.height) * deck.size.cy)
    placing = false
    pending = { anchor: { kind: 'slide' }, pos: { x, y }, label: 'At the marked point on the slide' }
  }

  async function postComment(text: string): Promise<boolean> {
    if (!slide || !pending || !author) return false
    const id = guid()
    const ok = await commentChange({ kind: 'addComment', slide: slide.part, id, author, created: new Date().toISOString(), text, anchor: pending.anchor, pos: pending.pos })
    if (ok) {
      pending = null
      focusedComment = id
    }
    return ok
  }

  const noAuthor = () => Promise.resolve(false)
  const replyComment = (part: string, comment: string, text: string) =>
    author ? commentChange({ kind: 'replyComment', slide: part, comment, id: guid(), author, created: new Date().toISOString(), text }) : noAuthor()
  const editComment = (part: string, comment: string, reply: string | null, text: string) => (author ? commentChange({ kind: 'editComment', slide: part, comment, reply, author, text }) : noAuthor())
  const commentStatus = (part: string, comment: string, status: 'active' | 'resolved') => commentChange({ kind: 'setCommentStatus', slide: part, comment, status })
  const deleteComment = (part: string, comment: string, reply: string | null) => (author ? commentChange({ kind: 'deleteComment', slide: part, comment, reply, author }) : noAuthor())

  function openThread(id: string) {
    showComments = true
    focusedComment = id
  }

  async function jumpTo(index: number, id: string) {
    await go(index)
    focusedComment = id
  }

  const fmtTime = (d: Date) => d.toLocaleTimeString(undefined, { timeStyle: 'short' })
</script>

{#snippet slideBox(index: number, place: 'main' | 'thumb' | 'show')}
  {@const out = draw(index, place)}
  {#if 'svg' in out}
    {@html out.svg}
  {:else}
    <div class="flex h-full w-full items-center justify-center bg-white p-4 text-center text-sm text-destructive" role="alert" data-testid="pptx-slide-error">
      Slide {index + 1} could not be drawn: {out.error}
    </div>
  {/if}
{/snippet}

{#snippet layoutList(at: number)}
  <div class="flex flex-col py-1" role="menu" aria-label="Layouts" data-testid="pptx-layouts">
    {#each layoutsHere as l (l.part)}
      <button type="button" role="menuitem" class="px-3 py-1.5 text-left text-xs hover:bg-muted focus-visible:bg-muted focus-visible:outline-none" onclick={() => void addSlide(l.part, at)} data-testid="pptx-layout">{l.name}</button>
    {/each}
  </div>
{/snippet}

<!-- The viewer takes the slide keys (arrows, Page Up/Down, Home/End, Esc while presenting, editing keys) for everything inside it. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  bind:this={rootEl}
  class="flex min-h-0 flex-1 flex-col outline-none"
  tabindex="-1"
  role="region"
  aria-label={`Slides of ${name}`}
  onkeydown={onKeydown}
  data-testid="pptx-viewer"
>
  {#if view.status === 'loading'}
    <div class="flex flex-1 items-center justify-center text-sm text-muted-foreground" data-testid="pptx-loading">Opening {name}…</div>
  {:else if view.status === 'error'}
    <div class="m-6 flex flex-col gap-1 text-sm" role="alert" data-testid="pptx-error">
      <p class="font-medium text-destructive">This presentation could not be opened.</p>
      <p class="text-muted-foreground">{view.message}</p>
    </div>
  {:else if count === 0}
    <p class="m-6 text-sm text-muted-foreground" data-testid="pptx-empty">This presentation has no slides.</p>
  {:else}
    {#if mode.kind === 'watching'}
      <div class="flex flex-wrap items-center gap-3 border-b bg-muted/40 px-4 py-2 text-sm" role="status" data-testid="pptx-lock-banner">
        <LockIcon class="size-4 text-muted-foreground" aria-hidden="true" />
        <span class="flex-1"><strong data-testid="pptx-lock-holder">{mode.holder.name}</strong> is editing. You see the last saved version, read-only.</span>
        <Button size="sm" variant="outline" disabled={locking} onclick={() => void takeOver()} data-testid="pptx-takeover">Take over</Button>
      </div>
    {:else if mode.kind === 'lost'}
      <div class="flex flex-wrap items-center gap-3 border-b border-destructive/40 bg-destructive/5 px-4 py-2 text-sm" role="alert" data-testid="pptx-lost-banner">
        <CircleAlertIcon class="size-4 text-destructive" aria-hidden="true" />
        <span class="flex-1"><strong data-testid="pptx-lost-holder">{mode.holder?.name ?? 'Someone'}</strong> took over editing. Your copy stays here, read-only; changes not saved yet are only in it.</span>
        <Button size="sm" variant="outline" onclick={downloadCopy} data-testid="pptx-download-copy"><DownloadIcon class="size-4" aria-hidden="true" /> Download my copy</Button>
        <Button size="sm" variant="outline" disabled={locking} onclick={() => void takeOver()} data-testid="pptx-takeover">Take it back</Button>
      </div>
    {/if}

    <div class="flex flex-wrap items-center gap-2 border-b px-3 py-2">
      <Button variant="ghost" size="icon-sm" aria-label="Previous slide" title="Previous slide (←)" disabled={current === 0} onclick={() => step(-1)} data-testid="pptx-prev">
        <ChevronLeftIcon class="size-4" aria-hidden="true" />
      </Button>
      <span class="min-w-24 text-center text-sm tabular-nums" aria-live="polite" data-testid="pptx-counter">Slide {current + 1} of {count}</span>
      <Button variant="ghost" size="icon-sm" aria-label="Next slide" title="Next slide (→)" disabled={current === count - 1} onclick={() => step(1)} data-testid="pptx-next">
        <ChevronRightIcon class="size-4" aria-hidden="true" />
      </Button>
      {#if slide?.hidden}
        <span class="inline-flex items-center gap-1 rounded-full border px-2 py-px text-xs text-muted-foreground" data-testid="pptx-hidden-badge">
          <EyeOffIcon class="size-3" aria-hidden="true" /> Hidden in the slide show
        </span>
      {/if}
      <div class="ml-auto flex items-center gap-2">
        {#if editing}
          <span class="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="pptx-save-state" data-status={save.status} data-held={held ? 'true' : 'false'} aria-live="polite">
            {#if locking}
              <LoaderIcon class="size-3.5 animate-spin" aria-hidden="true" /> Opening for editing…
            {:else if save.status === 'saving'}
              <LoaderIcon class="size-3.5 animate-spin" aria-hidden="true" /> Saving…
            {:else if save.status === 'dirty'}
              Unsaved changes
            {:else if save.status === 'error'}
              <CircleAlertIcon class="size-3.5 text-destructive" aria-hidden="true" /><span class="text-destructive" title={save.error ?? ''}>Couldn’t save</span>
              <Button size="sm" variant="outline" class="h-6 px-2 text-xs" onclick={() => void autosave.retry()} data-testid="pptx-save-retry">Retry</Button>
            {:else if save.savedAt}
              <CheckIcon class="size-3.5" aria-hidden="true" /> Saved {fmtTime(save.savedAt)}
            {:else}
              Editing — changes save automatically
            {/if}
          </span>
          <Button variant="outline" size="sm" onclick={() => void stopEditing()} data-testid="pptx-done">Done</Button>
        {:else if canEdit && mode.kind === 'viewing'}
          <Button variant="outline" size="sm" onclick={startEditing} data-testid="pptx-edit"><PencilIcon class="size-4" aria-hidden="true" /> Edit</Button>
        {/if}
        <Button variant="outline" size="sm" aria-pressed={showComments} onclick={() => (showComments = !showComments)} data-testid="pptx-comments-toggle">
          <MessageSquareIcon class="size-4" aria-hidden="true" /> Comments{#if slide && slide.comments.threads.length}<span class="tabular-nums" data-testid="pptx-comments-count">({slide.comments.threads.length})</span>{/if}
        </Button>
        <Button variant="outline" size="sm" aria-pressed={showNotes} onclick={() => (showNotes = !showNotes)} data-testid="pptx-notes-toggle">
          <NotebookTextIcon class="size-4" aria-hidden="true" /> Notes
        </Button>
        <Button size="sm" onclick={() => void present()} title="Present full screen (Esc to stop)" data-testid="pptx-present">
          <PresentationIcon class="size-4" aria-hidden="true" /> Present
        </Button>
      </div>
    </div>

    {#if editing}
      <EditToolbar
        state={toolbar}
        text={typing !== null || textIds.length > 0}
        selection={selected.length > 0}
        canUndo={history.undo}
        canRedo={history.redo}
        onformat={(f) => void format(f)}
        onalign={(a) => void paragraphs({ align: a })}
        onbullets={(on) => void paragraphs({ bullets: on })}
        oninserttext={() => void insertText()}
        oninsertpicture={(f) => void insertPicture(f)}
        onarrange={(d) => void arrange(d)}
        onduplicate={() => void duplicate()}
        ondelete={() => void remove()}
        onundo={() => void undo()}
        onredo={() => void redo()}
      />
    {/if}
    {#if notice}
      <div class="flex items-center gap-2 border-b bg-amber-50 px-4 py-1.5 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" role="alert" data-testid="pptx-notice">
        <span class="flex-1">{notice}</span>
        <button type="button" class="rounded p-0.5 hover:bg-black/5" aria-label="Dismiss" onclick={() => (notice = null)}><XIcon class="size-3.5" aria-hidden="true" /></button>
      </div>
    {/if}

    <div class="flex min-h-0 flex-1">
      <div class="hidden w-44 shrink-0 flex-col border-r sm:flex">
        <ol bind:this={railEl} class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3" aria-label="Slides" data-testid="pptx-rail">
          {#each deck!.slides as s, i (s.part)}
            <li class="relative flex items-start gap-2" data-thumb={i} ondragover={(e) => onDragOver(e, i)} ondrop={(e) => void onDrop(e)} onfocusout={closeMenuOutside}>
              {#if dropAt === i}<span class="absolute -top-2 right-0 left-7 h-0.5 rounded bg-primary" aria-hidden="true" data-testid="pptx-drop-marker"></span>{/if}
              {#if dropAt === count && i === count - 1}<span class="absolute right-0 -bottom-2 left-7 h-0.5 rounded bg-primary" aria-hidden="true" data-testid="pptx-drop-marker"></span>{/if}
              <span class="w-5 shrink-0 pt-0.5 text-right text-xs text-muted-foreground tabular-nums" aria-hidden="true">{i + 1}</span>
              <button
                type="button"
                class={`block w-full overflow-hidden rounded-sm border bg-white outline-none focus-visible:ring-2 focus-visible:ring-ring ${i === current ? 'border-primary ring-2 ring-primary' : 'border-border hover:border-foreground/40'} ${s.hidden ? 'opacity-50' : ''} ${dragFrom === i ? 'opacity-40' : ''}`}
                style={`aspect-ratio:${aspect}`}
                aria-label={`Slide ${i + 1}${s.hidden ? ' (hidden)' : ''}${openCount(s) ? `, ${openCount(s)} open comment${openCount(s) === 1 ? '' : 's'}` : ''}`}
                aria-current={i === current ? 'true' : undefined}
                draggable={editing}
                ondragstart={(e) => onDragStart(e, i)}
                ondragend={() => {
                  dragFrom = null
                  dropAt = null
                }}
                oncontextmenu={(e) => {
                  if (!editing) return
                  e.preventDefault()
                  menuFor = i
                  layoutMenu = null
                }}
                onclick={() => void go(i)}
                {@attach whenVisible(s.part)}
                data-testid="pptx-thumb"
              >
                <span class="pointer-events-none block h-full w-full" aria-hidden="true" inert>
                  {#if thumbsShown[s.part]}{@render slideBox(i, 'thumb')}{/if}
                </span>
              </button>
              {#if openCount(s)}
                <span class="pointer-events-none absolute right-1 bottom-1 inline-flex items-center gap-0.5 rounded-full bg-amber-300 px-1.5 text-xs font-semibold text-amber-950 tabular-nums" aria-hidden="true" data-testid="pptx-thumb-comments">
                  <MessageSquareIcon class="size-2.5" aria-hidden="true" />{openCount(s)}
                </span>
              {/if}
              {#if editing}
                <button
                  type="button"
                  class="absolute top-1 right-1 rounded bg-background/90 p-0.5 text-muted-foreground shadow-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  aria-label={`Actions for slide ${i + 1}`}
                  aria-haspopup="menu"
                  aria-expanded={menuFor === i}
                  onclick={() => {
                    menuFor = menuFor === i ? null : i
                    layoutMenu = null
                  }}
                  data-testid="pptx-thumb-menu"
                >
                  <EllipsisIcon class="size-3.5" aria-hidden="true" />
                </button>
              {/if}
              {#if menuFor === i}
                <div class="absolute top-7 right-0 z-20 w-44 rounded-md border bg-popover text-popover-foreground shadow-md" data-testid="pptx-slide-menu">
                  {#if layoutMenu === i}
                    {@render layoutList(i + 1)}
                  {:else}
                    <div class="flex flex-col py-1" role="menu" aria-label={`Slide ${i + 1}`}>
                      <button type="button" role="menuitem" class="px-3 py-1.5 text-left text-xs hover:bg-muted" onclick={() => (layoutMenu = i)} data-testid="pptx-slide-add">New slide after…</button>
                      <button type="button" role="menuitem" class="px-3 py-1.5 text-left text-xs hover:bg-muted" onclick={() => void slideAction(i, 'duplicate')} data-testid="pptx-slide-duplicate">Duplicate</button>
                      <button type="button" role="menuitem" class="px-3 py-1.5 text-left text-xs hover:bg-muted" onclick={() => void slideAction(i, 'hide')} data-testid="pptx-slide-hide">{s.hidden ? 'Show in slide show' : 'Hide in slide show'}</button>
                      <button type="button" role="menuitem" class="px-3 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-50" disabled={i === 0} onclick={() => void slideAction(i, 'up')} data-testid="pptx-slide-up">Move up</button>
                      <button type="button" role="menuitem" class="px-3 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-50" disabled={i === count - 1} onclick={() => void slideAction(i, 'down')} data-testid="pptx-slide-down">Move down</button>
                      <button type="button" role="menuitem" class="px-3 py-1.5 text-left text-xs text-destructive hover:bg-muted disabled:opacity-50" disabled={count === 1} title={count === 1 ? 'A presentation keeps at least one slide' : undefined} onclick={() => void slideAction(i, 'delete')} data-testid="pptx-slide-delete">Delete</button>
                    </div>
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ol>
        {#if editing}
          <div class="relative border-t p-2" onfocusout={closeMenuOutside}>
            <Button variant="outline" size="sm" class="w-full" aria-haspopup="menu" aria-expanded={layoutMenu === 'rail'} onclick={() => (layoutMenu = layoutMenu === 'rail' ? null : 'rail')} data-testid="pptx-new-slide">
              <PlusIcon class="size-4" aria-hidden="true" /> New slide
            </Button>
            {#if layoutMenu === 'rail'}
              <div class="absolute right-2 bottom-full left-2 z-20 mb-1 rounded-md border bg-popover text-popover-foreground shadow-md">
                {@render layoutList(current + 1)}
              </div>
            {/if}
          </div>
        {/if}
      </div>

      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex min-h-0 flex-1 items-center justify-center bg-muted/30 p-4">
          <!-- Slide links are reached by keyboard through the viewer's Enter handling. -->
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div
            bind:this={slideEl}
            class="relative overflow-hidden bg-white shadow-sm ring-1 ring-border"
            style={`aspect-ratio:${aspect};width:min(100%, calc(68vh * ${aspect}))`}
            onclick={onSlideClick}
            data-testid="pptx-slide"
          >
            {#key current}{@render slideBox(current, 'main')}{/key}
            {#if editing}
              <SlideOverlay width={slideW} height={slideH} {items} {selected} {typing} target={shapeEl} onselect={select} oncommit={commitFrames} onedittext={(id) => void beginText(id, 'end')} />
            {/if}
            {#each markers as m (m.id)}
              <button
                type="button"
                class={`absolute z-10 inline-flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full rounded-bl-none text-xs font-semibold shadow ring-1 ring-black/20 ${focusedComment === m.id ? 'bg-primary text-primary-foreground' : 'bg-amber-300 text-amber-950'}`}
                style={`left:${m.x * 100}%;top:${m.y * 100}%`}
                aria-label={`Comment ${m.n}${m.legacy ? ' (older format)' : ''}`}
                onclick={(e) => {
                  e.stopPropagation()
                  openThread(m.id)
                }}
                data-testid="pptx-comment-marker"
                data-id={m.id}>{m.n}</button
              >
            {/each}
            {#if pending?.pos && deck}
              <span
                class="pointer-events-none absolute z-10 size-6 -translate-x-1/2 -translate-y-1/2 rounded-full rounded-bl-none border-2 border-dashed border-primary bg-primary/20"
                style={`left:${(pending.pos.x / deck.size.cx) * 100}%;top:${(pending.pos.y / deck.size.cy) * 100}%`}
                aria-hidden="true"
                data-testid="pptx-comment-pending"
              ></span>
            {/if}
            {#if placing}
              <button type="button" class="absolute inset-0 z-20 cursor-crosshair bg-primary/5" aria-label="Place the comment here" onclick={placeAt} data-testid="pptx-comment-place"></button>
            {/if}
          </div>
        </div>
        {#if showNotes}
          <section class="max-h-48 shrink-0 overflow-y-auto border-t px-4 py-3 text-sm" aria-label="Speaker notes" data-testid="pptx-notes">
            {#if editing}
              <textarea
                bind:this={notesEl}
                class="block min-h-20 w-full resize-y rounded-md border bg-background px-2 py-1.5 text-sm"
                aria-label="Speaker notes"
                placeholder="Add speaker notes"
                value={notesText}
                onfocus={() => void onNotesFocus()}
                onchange={(e) => commitNotes(e.currentTarget.value)}
                data-testid="pptx-notes-editor"
              ></textarea>
            {:else if notes.length === 0}
              <p class="text-muted-foreground">No speaker notes on this slide.</p>
            {:else}
              {#each notes as line, i (i)}
                <p class="whitespace-pre-wrap">{line}</p>
              {/each}
            {/if}
          </section>
        {/if}
      </div>
      {#if showComments}
        <CommentsPanel
          slides={deck!.slides}
          {current}
          me={author?.id ?? null}
          {canComment}
          offReason={commentsOff}
          {selectedShape}
          {pending}
          focused={focusedComment}
          {placing}
          deckError={deck!.commentsError}
          onstart={startComment}
          onpost={postComment}
          oncancel={() => {
            pending = null
            placing = false
          }}
          onreply={replyComment}
          onedit={editComment}
          onstatus={commentStatus}
          ondelete={deleteComment}
          onjump={(i, id) => void jumpTo(i, id)}
          onclose={() => (showComments = false)}
        />
      {/if}
    </div>
  {/if}

  {#if presenting && deck}
    <!-- Presenter mode takes the keys on this element (the viewer's keydown handler). -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      bind:this={presenterEl}
      class="fixed inset-0 z-50 flex items-center justify-center bg-black"
      role="dialog"
      aria-modal="true"
      aria-label={`Presenting ${name}`}
      tabindex="0"
      onclick={onPresenterClick}
      data-testid="pptx-presenter"
    >
      <div class="overflow-hidden bg-white" style={`aspect-ratio:${aspect};width:min(100vw, calc(100vh * ${aspect}))`} data-testid="pptx-presenter-slide">
        {#key current}{@render slideBox(current, 'show')}{/key}
      </div>
      <div class="absolute top-3 right-3 flex items-center gap-2 text-xs text-white/70">
        {#if fullscreenRefused}<span data-testid="pptx-no-fullscreen">Full screen is not available here — presenting in the window.</span>{/if}
        <span class="tabular-nums">{current + 1} / {count}</span>
        <button type="button" class="rounded p-1 hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none" aria-label="Stop presenting (Esc)" onclick={() => void stopPresenting()} data-testid="pptx-presenter-close">
          <XIcon class="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  {/if}
</div>
