<script lang="ts" module>
  import type { PdfPage } from './pdfjs'

  /** A PDF whose pages can be placed: the open file (index 0) and the ones inserted from the Drive. */
  export type OrganiserSource = { bytes: Uint8Array; name: string; pages: PdfPage[] }
</script>

<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- every notice link was built with resolve() where it was made (file, folder) */
  import CircleAlertIcon from '@lucide/svelte/icons/circle-alert'
  import FileOutputIcon from '@lucide/svelte/icons/file-output'
  import FilePlusIcon from '@lucide/svelte/icons/file-plus'
  import LockIcon from '@lucide/svelte/icons/lock'
  import Redo2Icon from '@lucide/svelte/icons/redo-2'
  import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw'
  import RotateCwIcon from '@lucide/svelte/icons/rotate-cw'
  import ScissorsIcon from '@lucide/svelte/icons/scissors'
  import SquarePlusIcon from '@lucide/svelte/icons/square-plus'
  import Trash2Icon from '@lucide/svelte/icons/trash-2'
  import Undo2Icon from '@lucide/svelte/icons/undo-2'
  import { onMount } from 'svelte'
  import { resolve } from '$app/paths'
  import { Button } from '$lib/components/ui/button'
  import { driveApi, type DriveItem, type LockHolder } from '$lib/drive/api'
  import { LockLostError } from '$lib/drive/autosave'
  import { createOfficeEditSession } from '../edit-session'
  import {
    dropTarget,
    isUnchanged,
    pageRangesLabel,
    planDelete,
    planInsert,
    planMove,
    planRotate,
    PdfOrganiseError,
    type PageSlot,
  } from './organise-plan'
  import { drawThumbnail } from './page-view'
  import PdfPicker from './pdf-picker.svelte'
  import { openPdf, type PdfLoadingTask } from './pdfjs'

  /**
   * Organise pages (plan/phase-office-files.md, P2): the open PDF's pages as
   * a grid to select (click, Shift-click for a range, ⌘/Ctrl-click to add),
   * drag into a new order, turn, delete; blank pages and pages of another
   * Drive PDF go in after the selection; selected pages can be saved as a new
   * file next to this one (Extract), or one new file per run of them (Split).
   * Changes are staged here (undo/redo) and written as one new revision on
   * Save, under the edit lock taken on the way in — the same rules as the
   * document editor: "<name> is editing" with Take over, and a taken-over
   * session keeps its staged pages on screen.
   */
  let {
    fileId,
    name,
    folderId,
    heartbeatMs,
    base,
    onsaved,
    onchanged,
    onclose,
  }: {
    fileId: string
    name: string
    /** The file's folder (null: the top level); undefined: the page did not say, so extracting is off. */
    folderId: string | null | undefined
    heartbeatMs: number
    base: OrganiserSource
    /** After Save: the file as the server has it, the bytes written, what could not be kept. */
    onsaved: (file: DriveItem, bytes: Uint8Array, warnings: string[]) => void
    /** The file changed on the server before anything was staged: show that version instead. */
    onchanged: (bytes: Uint8Array) => void
    onclose: () => void
  } = $props()

  type Item = PageSlot & { id: number }
  type Lock =
    | { kind: 'starting' }
    | { kind: 'held' }
    | { kind: 'locked'; holder: LockHolder }
    | { kind: 'lost'; holder: LockHolder | null }
    | { kind: 'stale' }
    | { kind: 'error'; message: string }
  type Notice = {
    kind: 'ok' | 'error'
    text: string
    link?: { href: string; label: string }
    warnings?: string[]
  }

  const THUMB = 128
  let nextId = 0
  const fresh = (slot: PageSlot): Item => ({ ...slot, id: nextId++ })

  // The base is fixed for this session: a new file mounts a new organiser.
  // svelte-ignore state_referenced_locally
  const baseCount = base.pages.length
  // svelte-ignore state_referenced_locally
  const sources: OrganiserSource[] = [base]
  const tasks: PdfLoadingTask[] = []

  let items = $state.raw<Item[]>(
    Array.from({ length: baseCount }, (_, page) =>
      fresh({ kind: 'page', source: 0, page, rotate: 0 }),
    ),
  )
  let undoStack = $state.raw<Item[][]>([])
  let redoStack = $state.raw<Item[][]>([])
  let selected = $state.raw<ReadonlySet<number>>(new Set())
  let anchor: number | null = null
  let lock = $state<Lock>({ kind: 'starting' })
  let busy = $state<'saving' | 'extracting' | 'inserting' | 'splitting' | null>(null)
  let notice = $state<Notice | null>(null)
  let dropAt = $state<number | null>(null)
  let picking = $state(false)
  let dragging = false
  let destroyed = false
  let root: HTMLDivElement

  const dirty = $derived(!isUnchanged(items, baseCount))
  const canStage = $derived(lock.kind === 'held' && busy === null)
  const picked = $derived(items.flatMap((it, i) => (selected.has(it.id) ? [i] : [])))
  const statusLine = $derived(
    [
      picked.length
        ? `${picked.length} of ${items.length} selected`
        : `${items.length} ${items.length === 1 ? 'page' : 'pages'}`,
      dirty ? 'not saved' : '',
    ]
      .filter(Boolean)
      .join(' · '),
  )

  // The session belongs to this file for the organiser's life.
  // svelte-ignore state_referenced_locally
  const session = createOfficeEditSession({
    fileId,
    heartbeatMs,
    onLost: (holder) => {
      lock = { kind: 'lost', holder }
    },
  })

  let observer: IntersectionObserver | null = null
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- what each thumbnail slot shows, for the drawing code
  const pending = new Map<Element, Item>()

  onMount(() => {
    observer = new IntersectionObserver(onSeen, { rootMargin: '200px 0px' })
    for (const el of pending.keys()) observer.observe(el)
    void begin(false)
    return () => {
      destroyed = true
      observer?.disconnect()
      void session.stop()
      for (const t of tasks) void t.destroy()
    }
  })

  function messageOf(err: unknown) {
    return err instanceof Error ? err.message : String(err)
  }

  function sameBytes(a: Uint8Array, b: Uint8Array) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }

  /** Takes the edit lock and checks the file is still the version on screen. */
  async function begin(takeover: boolean) {
    notice = null
    lock = { kind: 'starting' }
    try {
      const view = await session.start({ takeover })
      if (destroyed) return
      if (view.state === 'locked') {
        lock = { kind: 'locked', holder: view.holder }
        return
      }
      if (view.state !== 'held') {
        lock = { kind: 'error', message: 'The file could not be opened for editing.' }
        return
      }
      const now = await driveApi.readBytes(fileId)
      if (destroyed) return
      if (!sameBytes(now, base.bytes)) {
        await session.stop()
        if (!dirty) onchanged(now)
        else lock = { kind: 'stale' }
        return
      }
      lock = { kind: 'held' }
    } catch (err) {
      if (!destroyed) lock = { kind: 'error', message: messageOf(err) }
    }
  }

  // --- staging -------------------------------------------------------------

  function edit(next: Item[]) {
    if (next.length === items.length && next.every((it, i) => it === items[i])) return
    undoStack = [...undoStack, items]
    redoStack = []
    items = next
    keepSelection()
  }

  function keepSelection() {
    const ids = new Set(items.map((i) => i.id))
    selected = new Set([...selected].filter((id) => ids.has(id)))
  }

  function undo() {
    const prev = undoStack.at(-1)
    if (!prev || !canStage) return
    redoStack = [...redoStack, items]
    undoStack = undoStack.slice(0, -1)
    items = prev
    keepSelection()
  }

  function redo() {
    const next = redoStack.at(-1)
    if (!next || !canStage) return
    undoStack = [...undoStack, items]
    redoStack = redoStack.slice(0, -1)
    items = next
    keepSelection()
  }

  function attempt(work: () => void) {
    notice = null
    try {
      work()
    } catch (err) {
      if (err instanceof PdfOrganiseError) notice = { kind: 'error', text: err.message }
      else throw err
    }
  }

  const rotate = (by: number) => attempt(() => edit(planRotate(items, picked, by)))
  const remove = () => attempt(() => edit(planDelete(items, picked)))
  const insertAt = () => (picked.length ? picked[picked.length - 1]! + 1 : items.length)

  /** How big a slot looks, in points (rotation applied). */
  function seenSize(item: Item): { width: number; height: number } {
    if (item.kind === 'blank') return { width: item.width, height: item.height }
    const page = sources[item.source]!.pages[item.page]!
    const v = page.getViewport({ scale: 1, rotation: (page.rotate + item.rotate) % 360 })
    return { width: v.width, height: v.height }
  }

  function insertBlank() {
    const at = insertAt()
    const neighbour = items[Math.max(0, at - 1)]!
    const blank = fresh({ kind: 'blank', ...seenSize(neighbour) })
    attempt(() => edit(planInsert(items, at, [blank])))
    selected = new Set([blank.id])
    anchor = blank.id
  }

  async function insertFrom(file: DriveItem) {
    picking = false
    notice = null
    busy = 'inserting'
    let task: PdfLoadingTask | null = null
    try {
      const bytes = await driveApi.readBytes(file.id)
      // pdf-lib must be able to write its pages back (an encrypted PDF fails here, plainly).
      await (await import('./organise')).pdfPageCount({ bytes, name: file.name })
      task = await openPdf(bytes.slice(), () => {
        void task?.destroy()
      })
      const doc = await task.promise
      const pages = await Promise.all(
        Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)),
      )
      if (destroyed) return
      tasks.push(task)
      sources.push({ bytes, name: file.name, pages })
      const source = sources.length - 1
      const added = pages.map((_, page) => fresh({ kind: 'page', source, page, rotate: 0 }))
      edit(planInsert(items, insertAt(), added))
      selected = new Set(added.map((a) => a.id))
      anchor = added[0]?.id ?? null
    } catch (err) {
      void task?.destroy()
      notice = {
        kind: 'error',
        text: `Pages of “${file.name}” could not be added: ${messageOf(err)}`,
      }
    } finally {
      busy = null
    }
  }

  // --- selection, keys, drag -------------------------------------------------

  function choose(item: Item, index: number, event: MouseEvent | KeyboardEvent) {
    if (event.shiftKey && anchor !== null) {
      const from = items.findIndex((it) => it.id === anchor)
      const [a, b] = from <= index ? [from, index] : [index, from]
      selected = new Set(items.slice(a, b + 1).map((it) => it.id))
      return
    }
    if (event.metaKey || event.ctrlKey) {
      selected = selected.has(item.id)
        ? new Set([...selected].filter((id) => id !== item.id))
        : new Set([...selected, item.id])
    } else selected = new Set([item.id])
    anchor = item.id
  }

  function onTileKey(event: KeyboardEvent, item: Item, index: number) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      choose(item, index, event)
    } else if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      // Move the selection one place (the keyboard's drag).
      event.preventDefault()
      if (!canStage) return
      if (!selected.has(item.id)) selected = new Set([item.id])
      const indices = items.flatMap((it, i) => (selected.has(it.id) ? [i] : []))
      const to = indices[0]! + (event.key === 'ArrowLeft' ? -1 : 1)
      if (to < 0 || to > items.length - indices.length) return
      attempt(() => edit(planMove(items, indices, to)))
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented) return
    const target = event.target
    if (target instanceof Element && target.closest('[role="dialog"], [role="alertdialog"]')) return
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    )
      return
    if (target instanceof Node && target !== document.body && !root.contains(target)) return
    const mod = event.metaKey || event.ctrlKey
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
    } else if (mod && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      selected = new Set(items.map((i) => i.id))
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && picked.length) {
      event.preventDefault()
      if (canStage) remove()
    } else if (event.key === 'Escape' && picked.length) {
      selected = new Set()
    }
  }

  function onDragStart(event: DragEvent, item: Item) {
    if (!canStage) {
      event.preventDefault()
      return
    }
    if (!selected.has(item.id)) {
      selected = new Set([item.id])
      anchor = item.id
    }
    dragging = true
    event.dataTransfer?.setData('application/x-pdf-pages', String(picked.length))
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  }

  /** Dropping on a tile's left half puts the pages before it, on its right half after it. */
  function dropIndex(event: DragEvent, index: number) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    return event.clientX < rect.left + rect.width / 2 ? index : index + 1
  }

  function onDragOver(event: DragEvent, index: number) {
    if (!dragging) return
    event.preventDefault()
    dropAt = dropIndex(event, index)
  }

  function onDrop(event: DragEvent, index: number) {
    if (!dragging) return
    event.preventDefault()
    const before = dropIndex(event, index)
    dragging = false
    dropAt = null
    if (!canStage) return
    attempt(() => edit(planMove(items, picked, dropTarget(picked, before))))
  }

  function onDragEnd() {
    dragging = false
    dropAt = null
  }

  // --- thumbnails -------------------------------------------------------------

  function aspect(item: Item) {
    const s = seenSize(item)
    return s.height / s.width
  }

  function thumb(item: Item) {
    return (el: HTMLElement) => {
      pending.set(el, item)
      observer?.observe(el)
      return () => {
        pending.delete(el)
        observer?.unobserve(el)
      }
    }
  }

  function onSeen(entries: IntersectionObserverEntry[]) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const el = entry.target as HTMLElement
      const item = pending.get(el)
      if (!item) continue
      pending.delete(el)
      observer?.unobserve(el)
      if (item.kind === 'blank') {
        el.dataset.drawn = 'true'
        continue
      }
      const page = sources[item.source]!.pages[item.page]!
      void drawThumbnail(page, THUMB, window.devicePixelRatio, item.rotate)
        .then((canvas) => {
          if (destroyed || !el.isConnected) return
          el.querySelector('canvas')?.remove()
          el.prepend(canvas)
          el.dataset.drawn = 'true'
        })
        .catch((err) => {
          notice = { kind: 'error', text: `A page could not be drawn: ${messageOf(err)}` }
        })
    }
  }

  // --- save, extract, leave -----------------------------------------------------

  async function save() {
    if (lock.kind !== 'held' || !dirty || busy) return
    busy = 'saving'
    notice = null
    try {
      const { composePdf } = await import('./organise')
      const out = await composePdf(sources, items)
      const file = await session.save(out.bytes)
      await session.stop()
      onsaved(file, out.bytes, out.warnings)
    } catch (err) {
      if (err instanceof LockLostError) {
        if ((lock as Lock).kind !== 'lost') lock = { kind: 'lost', holder: null }
      } else notice = { kind: 'error', text: `The changes could not be saved: ${messageOf(err)}` }
    } finally {
      busy = null
    }
  }

  function baseName(n: string) {
    return n.toLowerCase().endsWith('.pdf') ? n.slice(0, -4) : n
  }

  async function extract() {
    if (folderId === undefined || picked.length === 0 || busy) return
    busy = 'extracting'
    notice = null
    try {
      const { composePdf } = await import('./organise')
      const out = await composePdf(
        sources,
        picked.map((i) => items[i]!),
      )
      const fileName = `${baseName(name)} (pages ${pageRangesLabel(picked.map((i) => i + 1))}).pdf`
      const upload = new File([out.bytes.slice().buffer as ArrayBuffer], fileName, {
        type: 'application/pdf',
      })
      const res = await driveApi.upload(folderId, [upload])
      const created = res.uploaded[0]
      if (!created) throw new Error(res.errors.join(' ') || 'The Drive did not take the file.')
      notice = {
        kind: 'ok',
        text: `Saved the ${picked.length === 1 ? 'page' : `${picked.length} pages`} as “${created.name}” next to this file.`,
        link: { href: resolve(`/drive/file/${created.id}`), label: 'Open it' },
        warnings: out.warnings,
      }
    } catch (err) {
      notice = { kind: 'error', text: `The pages could not be extracted: ${messageOf(err)}` }
    } finally {
      busy = null
    }
  }

  /** Each contiguous run of the selection, as [from, to] indices into items. */
  function runsOf(indices: readonly number[]): Array<[number, number]> {
    const runs: Array<[number, number]> = []
    for (const i of indices) {
      const last = runs.at(-1)
      if (last && i === last[1] + 1) last[1] = i
      else runs.push([i, i])
    }
    return runs
  }

  async function split() {
    if (folderId === undefined || picked.length === 0 || busy) return
    busy = 'splitting'
    notice = null
    try {
      const { composePdf } = await import('./organise')
      const runs = runsOf(picked)
      const parts: File[] = []
      const warningsByPart: string[][] = []
      for (const [from, to] of runs) {
        const label = from === to ? `page ${from + 1}` : `pages ${from + 1}–${to + 1}`
        const out = await composePdf(sources, items.slice(from, to + 1))
        parts.push(
          new File([out.bytes.slice().buffer as ArrayBuffer], `${baseName(name)} (${label}).pdf`, {
            type: 'application/pdf',
          }),
        )
        warningsByPart.push(out.warnings)
      }
      const res = await driveApi.upload(folderId, parts)
      const created = res.uploaded
      if (created.length !== parts.length)
        throw new Error(res.errors.join(' ') || 'The Drive did not take every file.')
      notice = {
        kind: 'ok',
        text: `Split ${picked.length === 1 ? '1 page' : `${picked.length} pages`} into ${created.length === 1 ? '1 file' : `${created.length} files`} next to this one: ${created.map((c) => `“${c.name}”`).join(', ')}.`,
        link: {
          href: folderId ? resolve(`/drive/folder/${folderId}`) : resolve('/drive'),
          label: 'Open the folder',
        },
        warnings: created.flatMap((c, k) =>
          (warningsByPart[k] ?? []).map((w) => `${c.name}: ${w}`),
        ),
      }
    } catch (err) {
      notice = { kind: 'error', text: `The pages could not be split off: ${messageOf(err)}` }
    } finally {
      busy = null
    }
  }

  async function discard() {
    await session.stop()
    onclose()
  }

  function onBeforeUnload(event: BeforeUnloadEvent) {
    if (dirty) event.preventDefault()
  }
</script>

<svelte:window onkeydown={onKeydown} onbeforeunload={onBeforeUnload} />

<div
  bind:this={root}
  class="pdf-organiser"
  data-testid="pdf-organiser"
  data-lock={lock.kind}
  data-dirty={dirty}
>
  <div
    class="flex flex-wrap items-center gap-1 border-b bg-muted/30 px-2 py-1.5 text-sm"
    role="toolbar"
    aria-label="Organise pages"
  >
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Rotate left"
      title="Rotate left"
      disabled={!canStage || picked.length === 0}
      onclick={() => rotate(-90)}
      data-testid="pdf-org-rotate-left"><RotateCcwIcon class="size-4" /></Button
    >
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Rotate right"
      title="Rotate right"
      disabled={!canStage || picked.length === 0}
      onclick={() => rotate(90)}
      data-testid="pdf-org-rotate-right"><RotateCwIcon class="size-4" /></Button
    >
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Delete pages"
      title="Delete pages (Delete)"
      disabled={!canStage || picked.length === 0}
      onclick={remove}
      data-testid="pdf-org-delete"><Trash2Icon class="size-4" /></Button
    >
    <span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
    <Button
      variant="ghost"
      size="sm"
      disabled={!canStage}
      onclick={insertBlank}
      data-testid="pdf-org-insert-blank"><SquarePlusIcon class="size-4" /> Blank page</Button
    >
    <Button
      variant="ghost"
      size="sm"
      disabled={!canStage}
      onclick={() => (picking = true)}
      data-testid="pdf-org-insert-pdf"><FilePlusIcon class="size-4" /> From a PDF…</Button
    >
    {#if folderId !== undefined}
      <Button
        variant="ghost"
        size="sm"
        title="Save the selected pages as a new PDF next to this file"
        disabled={picked.length === 0 || busy !== null || lock.kind === 'starting'}
        onclick={extract}
        data-testid="pdf-org-extract"><FileOutputIcon class="size-4" /> Extract</Button
      >
      <Button
        variant="ghost"
        size="sm"
        title="One new PDF per run of selected pages, next to this file"
        disabled={picked.length === 0 || busy !== null || lock.kind === 'starting'}
        onclick={split}
        data-testid="pdf-org-split"><ScissorsIcon class="size-4" /> Split</Button
      >
    {/if}
    <span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Undo"
      title="Undo (⌘Z)"
      disabled={!canStage || undoStack.length === 0}
      onclick={undo}
      data-testid="pdf-org-undo"><Undo2Icon class="size-4" /></Button
    >
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Redo"
      title="Redo (⇧⌘Z)"
      disabled={!canStage || redoStack.length === 0}
      onclick={redo}
      data-testid="pdf-org-redo"><Redo2Icon class="size-4" /></Button
    >
    <span
      class="ml-2 text-xs text-muted-foreground tabular-nums"
      aria-live="polite"
      data-testid="pdf-org-status"
      >{busy === 'saving'
        ? 'Saving…'
        : busy === 'extracting'
          ? 'Extracting…'
          : busy === 'splitting'
            ? 'Splitting…'
            : busy === 'inserting'
              ? 'Adding pages…'
              : statusLine}</span
      >
    <div class="ml-auto flex items-center gap-1">
      <Button variant="outline" size="sm" onclick={discard} data-testid="pdf-org-discard"
        >{dirty ? 'Discard' : 'Done'}</Button
      >
      <Button
        size="sm"
        disabled={lock.kind !== 'held' || !dirty || busy !== null}
        onclick={save}
        data-testid="pdf-org-save">Save</Button
      >
    </div>
  </div>

  {#if lock.kind === 'starting'}
    <p class="border-b px-3 py-2 text-sm text-muted-foreground" role="status">
      Opening for editing…
    </p>
  {:else if lock.kind === 'locked'}
    <div
      class="flex flex-wrap items-center gap-3 border-b bg-muted/40 px-4 py-3 text-sm"
      role="status"
      data-testid="pdf-org-lock-banner"
    >
      <LockIcon class="size-4 text-muted-foreground" />
      <span class="flex-1"
        ><strong data-testid="pdf-org-lock-holder">{lock.holder.name}</strong> is editing. You see the
        last saved version and can arrange pages once they are done.</span
      >
      <Button size="sm" variant="outline" onclick={() => begin(true)} data-testid="pdf-org-takeover"
        >Take over</Button
      >
    </div>
  {:else if lock.kind === 'lost'}
    <div
      class="flex flex-wrap items-center gap-3 border-b border-destructive/40 bg-destructive/5 px-4 py-3 text-sm"
      role="alert"
      data-testid="pdf-org-lost-banner"
    >
      <CircleAlertIcon class="size-4 text-destructive" />
      <span class="flex-1"
        ><strong>{lock.holder?.name ?? 'Someone'}</strong> took over editing. Your page changes are not
        saved; they are still here.</span
      >
      <Button size="sm" variant="outline" onclick={() => begin(true)} data-testid="pdf-org-takeover"
        >Take it back</Button
      >
    </div>
  {:else if lock.kind === 'stale'}
    <p
      class="border-b border-destructive/40 bg-destructive/5 px-4 py-3 text-sm"
      role="alert"
      data-testid="pdf-org-stale"
    >
      This file changed since you opened it, so these page changes can’t be saved over it. Extract
      the pages you need, or discard to see the new version.
    </p>
  {:else if lock.kind === 'error'}
    <p
      class="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive"
      role="alert"
      data-testid="pdf-org-lock-error"
    >
      {lock.message}
    </p>
  {/if}

  {#if notice}
    <div
      class="border-b px-4 py-2 text-sm {notice.kind === 'error'
        ? 'border-destructive/40 bg-destructive/10 text-destructive'
        : 'bg-muted/40'}"
      role={notice.kind === 'error' ? 'alert' : 'status'}
      data-testid="pdf-org-notice"
    >
      <p>
        {notice.text}
        {#if notice.link}<a class="underline" href={notice.link.href}>{notice.link.label}</a>{/if}
      </p>
      {#if notice.warnings?.length}
        <ul class="mt-1 list-disc pl-5" data-testid="pdf-org-warnings">
          {#each notice.warnings as w (w)}<li>{w}</li>{/each}
        </ul>
      {/if}
    </div>
  {/if}

  <div class="pdf-org-scroll bg-muted/40">
    <ol
      class="pdf-org-grid"
      role="listbox"
      aria-multiselectable="true"
      aria-label={`Pages of ${name}`}
      data-testid="pdf-org-grid"
    >
      {#each items as item, i (item.id)}
        <li
          class="pdf-org-tile"
          class:drop-before={dropAt === i}
          class:drop-after={dropAt === items.length && i === items.length - 1}
          role="option"
          aria-selected={selected.has(item.id)}
          aria-label={`Page ${i + 1}${item.kind === 'blank' ? ', blank' : item.source !== 0 ? `, from ${sources[item.source]!.name}` : ''}`}
          tabindex="0"
          draggable={canStage}
          data-testid="pdf-org-page"
          data-kind={item.kind}
          data-source={item.kind === 'page' ? item.source : undefined}
          data-page={item.kind === 'page' ? item.page : undefined}
          data-turn={item.kind === 'page' ? item.rotate : 0}
          onclick={(e) => choose(item, i, e)}
          onkeydown={(e) => onTileKey(e, item, i)}
          ondragstart={(e) => onDragStart(e, item)}
          ondragover={(e) => onDragOver(e, i)}
          ondrop={(e) => onDrop(e, i)}
          ondragend={onDragEnd}
        >
          <span
            class="pdf-org-frame"
            style:width={`${THUMB}px`}
            style:height={`${Math.round(aspect(item) * THUMB)}px`}
            {@attach thumb(item)}
          ></span>
          <span class="text-xs text-muted-foreground tabular-nums">
            {i + 1}{item.kind === 'blank' ? ' · blank' : ''}
          </span>
        </li>
      {/each}
    </ol>
  </div>
</div>

{#if picking}
  <PdfPicker exclude={fileId} onpick={insertFrom} onclose={() => (picking = false)} />
{/if}

<style>
  .pdf-organiser {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .pdf-org-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 1rem;
  }
  .pdf-org-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    align-items: flex-end;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .pdf-org-tile {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 0.375rem;
    border-radius: 0.375rem;
    cursor: pointer;
    user-select: none;
    outline: none;
  }
  .pdf-org-tile:focus-visible {
    box-shadow: 0 0 0 2px var(--ring, #2563eb);
  }
  .pdf-org-tile[aria-selected='true'] {
    background: color-mix(in srgb, var(--primary, #2563eb) 14%, transparent);
  }
  .pdf-org-tile[aria-selected='true'] .pdf-org-frame {
    box-shadow: 0 0 0 2px var(--primary, #2563eb);
  }
  .pdf-org-tile.drop-before::before,
  .pdf-org-tile.drop-after::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    width: 3px;
    border-radius: 2px;
    background: var(--primary, #2563eb);
  }
  .pdf-org-tile.drop-before::before {
    left: -0.6rem;
  }
  .pdf-org-tile.drop-after::after {
    right: -0.6rem;
  }
  .pdf-org-frame {
    position: relative;
    display: block;
    background: white;
    box-shadow: 0 0 0 1px rgb(0 0 0 / 0.12);
  }
  .pdf-org-frame :global(canvas) {
    width: 100%;
    height: 100%;
  }
</style>
