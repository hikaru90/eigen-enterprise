<script lang="ts">
  import type { PdfContents, PdfEdits } from './edit'
  import type { FieldValue } from './forms'
  import type { PropertiesPatch } from './properties'
  import CircleIcon from '@lucide/svelte/icons/circle'
  import CircleAlertIcon from '@lucide/svelte/icons/circle-alert'
  import FileTextIcon from '@lucide/svelte/icons/file-text'
  import HighlighterIcon from '@lucide/svelte/icons/highlighter'
  import LockIcon from '@lucide/svelte/icons/lock'
  import MousePointerIcon from '@lucide/svelte/icons/mouse-pointer-2'
  import MoveUpRightIcon from '@lucide/svelte/icons/move-up-right'
  import PenLineIcon from '@lucide/svelte/icons/pen-line'
  import Redo2Icon from '@lucide/svelte/icons/redo-2'
  import SquareIcon from '@lucide/svelte/icons/square'
  import StickyNoteIcon from '@lucide/svelte/icons/sticky-note'
  import StrikethroughIcon from '@lucide/svelte/icons/strikethrough'
  import Trash2Icon from '@lucide/svelte/icons/trash-2'
  import TypeIcon from '@lucide/svelte/icons/type'
  import UnderlineIcon from '@lucide/svelte/icons/underline'
  import Undo2Icon from '@lucide/svelte/icons/undo-2'
  import WavesIcon from '@lucide/svelte/icons/waves'
  import ZoomInIcon from '@lucide/svelte/icons/zoom-in'
  import ZoomOutIcon from '@lucide/svelte/icons/zoom-out'
  import { onMount, tick, type Component } from 'svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import { driveApi, type DriveItem, type LockHolder } from '$lib/drive/api'
  import { LockLostError } from '$lib/drive/autosave'
  import { driveShownError } from '$lib/drive/shown-error'
  import type { ShownError } from '$lib/errors/agent-report'
  import { createOfficeEditSession } from '../edit-session'
  import {
    foldEdits,
    hexRgb,
    kindLabel,
    newKey,
    PdfEditError,
    rgbHex,
    threadsOf,
    type AnnotationEdit,
    type Measure,
    type NewAnnotation,
  } from './annotate-model'
  import { CSS_PER_POINT } from './layout'
  import PdfComments from './pdf-comments.svelte'
  import PdfEditPage, { type EditTool } from './pdf-edit-page.svelte'
  import { type PdfJs, type PdfPage } from './pdfjs'

  /**
   * Annotate, fill the form, set the properties (plan/phase-office-files.md
   * P3). Every change is staged here with undo and redo and written as one
   * new revision on Save, under the edit lock taken on the way in — the same
   * rules as Organise: "<name> is editing" with Take over, and a session
   * that loses the lock keeps its staged changes on screen.
   *
   * Annotations are signed with the signed-in member's name; without one
   * Annotate stays off (form and properties still work: they carry no author).
   */
  let {
    fileId,
    name,
    heartbeatMs,
    author,
    lib,
    base,
    startIn,
    onsaved,
    onchanged,
    onclose,
  }: {
    fileId: string
    name: string
    heartbeatMs: number
    author: { id: string; name: string } | undefined
    lib: PdfJs
    base: { bytes: Uint8Array; pages: PdfPage[] }
    startIn: 'annotate' | 'form'
    onsaved: (file: DriveItem, bytes: Uint8Array, warnings: string[]) => void
    onchanged: (bytes: Uint8Array) => void
    onclose: () => void
  } = $props()

  type Staged = {
    edits: AnnotationEdit[]
    fields: Record<string, FieldValue>
    flatten: boolean
    properties: PropertiesPatch
  }
  type Lock =
    | { kind: 'starting' }
    | { kind: 'held' }
    | { kind: 'locked'; holder: LockHolder }
    | { kind: 'lost'; holder: LockHolder | null }
    | { kind: 'stale' }
    | ({ kind: 'error' } & ShownError)

  const EMPTY: Staged = { edits: [], fields: {}, flatten: false, properties: {} }
  const COLOURS = ['#ffd400', '#ff5c5c', '#3b82f6', '#22c55e', '#a855f7', '#000000']
  const TOOLS: Array<{ tool: EditTool; label: string; icon: Component }> = [
    { tool: 'select', label: 'Select and move', icon: MousePointerIcon },
    { tool: 'Highlight', label: 'Highlight text', icon: HighlighterIcon },
    { tool: 'Underline', label: 'Underline text', icon: UnderlineIcon },
    { tool: 'StrikeOut', label: 'Strike text through', icon: StrikethroughIcon },
    { tool: 'Squiggly', label: 'Squiggly underline', icon: WavesIcon },
    { tool: 'Text', label: 'Note', icon: StickyNoteIcon },
    { tool: 'FreeText', label: 'Text box', icon: TypeIcon },
    { tool: 'Ink', label: 'Draw', icon: PenLineIcon },
    { tool: 'Square', label: 'Rectangle', icon: SquareIcon },
    { tool: 'Circle', label: 'Ellipse', icon: CircleIcon },
    { tool: 'Line', label: 'Arrow', icon: MoveUpRightIcon },
  ]

  let contents = $state.raw<PdfContents | null>(null)
  let measure = $state.raw<Measure>(() => 0)
  let loadError = $state<ShownError | null>(null)
  let staged = $state.raw<Staged>(EMPTY)
  let undoStack = $state.raw<Staged[]>([])
  let redoStack = $state.raw<Staged[]>([])
  /** Typing into one field is one undo step. */
  let typingIn: string | null = null
  // svelte-ignore state_referenced_locally
  let mode = $state<'annotate' | 'form'>(author ? startIn : 'form')
  let tool = $state<EditTool>('select')
  let colour = $state(COLOURS[0]!)
  let opacity = $state(1)
  let strokeWidth = $state(2)
  let selected = $state<string | null>(null)
  let zoom = $state(1)
  let lock = $state<Lock>({ kind: 'starting' })
  let busy = $state<'saving' | null>(null)
  let notice = $state<ShownError | null>(null)
  let propertiesOpen = $state(false)
  let PropertiesDialog = $state.raw<Component<{
    properties: import('./properties').PdfProperties
    canStage: boolean
    onapply: (patch: PropertiesPatch) => void
    onclose: () => void
  }> | null>(null)
  let destroyed = false
  let root: HTMLDivElement
  let scroller: HTMLDivElement
  const pageViews: Array<{ refresh(): void } | null> = []

  // svelte-ignore state_referenced_locally
  const session = createOfficeEditSession({
    fileId,
    heartbeatMs,
    onLost: (holder) => {
      lock = { kind: 'lost', holder }
    },
  })

  const editContext = () => ({ author: author?.name ?? '', now: new Date() })
  const annotations = $derived(
    contents ? foldEdits(contents.annotations, staged.edits, editContext()) : [],
  )
  const threads = $derived(threadsOf(annotations))
  const others = $derived(annotations.filter((a) => a.kind === 'Other').length)
  const fields = $derived(contents?.form.fields ?? [])
  const dirty = $derived(
    staged.edits.length > 0 ||
      Object.keys(staged.fields).length > 0 ||
      staged.flatten ||
      Object.keys(staged.properties).length > 0,
  )
  const canStage = $derived(lock.kind === 'held' && busy === null && contents !== null)
  const canAnnotate = $derived(canStage && !!author)
  const selectedAnnotation = $derived(annotations.find((a) => a.id === selected) ?? null)
  const scale = $derived(zoom * CSS_PER_POINT)
  const properties = $derived(contents ? { ...contents.properties, ...staged.properties } : null)

  onMount(() => {
    void load()
    void begin(false)
    return () => {
      destroyed = true
      void session.stop()
    }
  })

  function messageOf(err: unknown) {
    return err instanceof Error ? err.message : String(err)
  }

  async function load() {
    try {
      const [{ readPdfContents }, { PDFDocument }, { helveticaMeasure }] = await Promise.all([
        import('./edit'),
        import('pdf-lib/dist/pdf-lib.esm.js'),
        import('./annotate'),
      ])
      const [read, helv] = await Promise.all([
        readPdfContents({ bytes: base.bytes, name }),
        PDFDocument.create().then((d) => helveticaMeasure(d)),
      ])
      if (destroyed) return
      measure = helv.measure
      contents = read
      await tick()
      fitWidth()
    } catch (err) {
      if (!destroyed) loadError = driveShownError(err)
    }
  }

  function fitWidth() {
    const widest = Math.max(...base.pages.map((p) => p.getViewport({ scale: 1 }).width))
    const room = scroller.clientWidth - 48
    zoom = Math.max(0.4, Math.min(2, room / (widest * CSS_PER_POINT)))
    void tick().then(refreshPages)
  }

  function setZoom(next: number) {
    zoom = Math.max(0.25, Math.min(4, next))
    void tick().then(refreshPages)
  }

  function refreshPages() {
    for (const v of pageViews) v?.refresh()
  }

  function sameBytes(a: Uint8Array, b: Uint8Array) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }

  /** Takes the edit lock and checks the file is still the version on screen. */
  async function begin(takeover: boolean) {
    lock = { kind: 'starting' }
    try {
      const view = await session.start({ takeover })
      if (destroyed) return
      if (view.state === 'locked') {
        lock = { kind: 'locked', holder: view.holder }
        return
      }
      if (view.state !== 'held') {
        lock = { kind: 'error', error: 'The file could not be opened for editing.', agent: null }
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
      if (!destroyed) lock = { kind: 'error', ...driveShownError(err) }
    }
  }

  // --- staging -------------------------------------------------------------------

  /** Stages a change (checked against the model first), one undo step. */
  function stage(next: Staged, coalesce: string | null = null) {
    notice = null
    if (!contents) return
    try {
      foldEdits(contents.annotations, next.edits, editContext())
    } catch (err) {
      if (err instanceof PdfEditError) {
        notice = { error: err.message, agent: null }
        return
      }
      throw err
    }
    if (coalesce === null || coalesce !== typingIn) {
      undoStack = [...undoStack, staged]
      redoStack = []
    }
    typingIn = coalesce
    staged = next
  }

  const edit = (...e: AnnotationEdit[]) => stage({ ...staged, edits: [...staged.edits, ...e] })

  function undo() {
    const prev = undoStack.at(-1)
    if (!prev || !canStage) return
    redoStack = [...redoStack, staged]
    undoStack = undoStack.slice(0, -1)
    staged = prev
    typingIn = null
    if (selected && !annotations.some((a) => a.id === selected)) selected = null
  }

  function redo() {
    const next = redoStack.at(-1)
    if (!next || !canStage) return
    undoStack = [...undoStack, staged]
    redoStack = redoStack.slice(0, -1)
    staged = next
    typingIn = null
  }

  function onadd(a: NewAnnotation) {
    if (!canAnnotate) return
    const key = newKey()
    edit({ op: 'add', key, annotation: a })
    selected = key
  }

  function onmove(id: string, dx: number, dy: number) {
    if (canAnnotate) edit({ op: 'update', id, patch: { move: [dx, dy] } })
  }

  function pickColour(hex: string) {
    colour = hex
    const a = selectedAnnotation
    if (a && a.shape && canAnnotate) edit({ op: 'update', id: a.id, patch: { color: hexRgb(hex) } })
  }

  function pickOpacity(value: number) {
    opacity = value
    const a = selectedAnnotation
    if (a && a.shape && canAnnotate && a.opacity !== value)
      edit({ op: 'update', id: a.id, patch: { opacity: value } })
  }

  function removeSelected() {
    if (selected && canAnnotate) {
      edit({ op: 'delete', id: selected })
      selected = null
    }
  }

  function onfield(fieldName: string, value: FieldValue) {
    if (!canStage) return
    stage({ ...staged, fields: { ...staged.fields, [fieldName]: value } }, fieldName)
  }

  function onSelectAnnotation(id: string | null) {
    selected = id
    const a = annotations.find((x) => x.id === id)
    if (a?.color) colour = rgbHex(a.color)
    if (a) opacity = a.opacity
  }

  async function revealAnnotation(id: string) {
    onSelectAnnotation(id)
    mode = 'annotate'
    tool = 'select'
    const a = annotations.find((x) => x.id === id)
    if (!a) return
    await tick()
    scroller
      .querySelector(`[data-testid="pdf-edit-page"][data-page="${a.page}"]`)
      ?.scrollIntoView({ block: 'center' })
  }

  async function openProperties() {
    try {
      PropertiesDialog ??= (await import('./pdf-properties-dialog.svelte')).default
      propertiesOpen = true
    } catch (err) {
      notice = { error: `The properties could not be opened: ${messageOf(err)}`, agent: null }
    }
  }

  // --- save, leave -----------------------------------------------------------------

  async function save() {
    if (lock.kind !== 'held' || !dirty || busy) return
    busy = 'saving'
    notice = null
    try {
      const { applyPdfEdits } = await import('./edit')
      const edits: PdfEdits = {
        annotations: staged.edits,
        fields: staged.fields,
        flatten: staged.flatten,
        properties: staged.properties,
      }
      const out = await applyPdfEdits({ bytes: base.bytes, name }, edits, editContext())
      const file = await session.save(out.bytes)
      await session.stop()
      onsaved(file, out.bytes, out.warnings)
    } catch (err) {
      if (err instanceof LockLostError) {
        if ((lock as Lock).kind !== 'lost') lock = { kind: 'lost', holder: null }
      } else
        notice = {
          ...driveShownError(err),
          error: `The changes could not be saved: ${messageOf(err)}`,
        }
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

  function onKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented) return
    const target = event.target
    if (target instanceof Element && target.closest('[role="dialog"], [role="alertdialog"]')) return
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    )
      return
    if (target instanceof Node && target !== document.body && !root.contains(target)) return
    const mod = event.metaKey || event.ctrlKey
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && selected) {
      event.preventDefault()
      removeSelected()
    } else if (event.key === 'Escape' && selected) {
      selected = null
    }
  }
</script>

<svelte:window onkeydown={onKeydown} onbeforeunload={onBeforeUnload} />

<div
  bind:this={root}
  class="pdf-editor"
  data-testid="pdf-editor"
  data-lock={lock.kind}
  data-dirty={dirty}
  data-mode={mode}
  data-ready={contents !== null}
>
  <div
    class="flex flex-wrap items-center gap-1 border-b bg-muted/30 px-2 py-1.5 text-sm"
    role="toolbar"
    aria-label="Annotate and fill"
  >
    <div class="flex rounded-md border p-0.5" role="tablist" aria-label="Mode">
      <button
        type="button"
        role="tab"
        class="rounded px-2 py-0.5 aria-selected:bg-background aria-selected:shadow-sm disabled:opacity-50"
        aria-selected={mode === 'annotate'}
        disabled={!author}
        title={author
          ? 'Notes, markups and drawings'
          : 'Annotating needs your name, which this page doesn’t have'}
        onclick={() => (mode = 'annotate')}
        data-testid="pdf-edit-mode-annotate">Annotate</button
      >
      <button
        type="button"
        role="tab"
        class="rounded px-2 py-0.5 aria-selected:bg-background aria-selected:shadow-sm"
        aria-selected={mode === 'form'}
        onclick={() => {
          mode = 'form'
          selected = null
        }}
        data-testid="pdf-edit-mode-form">Fill form</button
      >
    </div>
    {#if mode === 'annotate'}
      <span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
      {#each TOOLS as t (t.tool)}
        {@const Icon = t.icon}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t.label}
          title={t.label}
          aria-pressed={tool === t.tool}
          disabled={!canAnnotate}
          onclick={() => {
            tool = t.tool
            if (t.tool !== 'select') selected = null
          }}
          data-testid={`pdf-tool-${t.tool}`}><Icon class="size-4" /></Button
        >
      {/each}
      <span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
      <div class="flex items-center gap-0.5" role="radiogroup" aria-label="Colour">
        {#each COLOURS as c (c)}
          <button
            type="button"
            role="radio"
            class="size-5 rounded-full border-2 aria-checked:border-foreground"
            style:background={c}
            aria-checked={colour === c}
            aria-label={`Colour ${c}`}
            disabled={!canAnnotate}
            onclick={() => pickColour(c)}
            data-testid="pdf-colour"
          ></button>
        {/each}
      </div>
      <label class="ml-1 flex items-center gap-1 text-xs text-muted-foreground">
        Opacity
        <input
          type="range"
          min="0.1"
          max="1"
          step="0.1"
          value={opacity}
          disabled={!canAnnotate}
          onchange={(e) => pickOpacity(Number(e.currentTarget.value))}
          aria-label="Opacity"
          data-testid="pdf-opacity"
        />
      </label>
      {#if tool === 'Ink' || tool === 'Square' || tool === 'Circle' || tool === 'Line'}
        <label class="ml-1 flex items-center gap-1 text-xs text-muted-foreground">
          Width
          <input
            type="number"
            class="h-6 w-12 rounded border bg-background px-1"
            min="0.5"
            max="20"
            step="0.5"
            bind:value={strokeWidth}
            aria-label="Line width"
          />
        </label>
      {/if}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Delete the selected annotation"
        title="Delete (Delete)"
        disabled={!canAnnotate || !selected}
        onclick={removeSelected}
        data-testid="pdf-edit-delete"><Trash2Icon class="size-4" /></Button
      >
    {:else if contents && (contents.form.kind === 'acroform' || contents.form.kind === 'hybrid')}
      <span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
      <label
        class="flex items-center gap-1.5 text-xs"
        title="Turns the form into page content for good"
      >
        <input
          type="checkbox"
          checked={staged.flatten}
          disabled={!canStage}
          onchange={(e) => stage({ ...staged, flatten: e.currentTarget.checked })}
          data-testid="pdf-flatten"
        />
        Flatten the form on save
      </label>
    {/if}
    <span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Zoom out"
      onclick={() => setZoom(zoom / 1.25)}><ZoomOutIcon class="size-4" /></Button
    >
    <Button variant="ghost" size="icon-sm" aria-label="Zoom in" onclick={() => setZoom(zoom * 1.25)}
      ><ZoomInIcon class="size-4" /></Button
    >
    <Button
      variant="ghost"
      size="sm"
      disabled={!contents}
      onclick={openProperties}
      data-testid="pdf-edit-properties"><FileTextIcon class="size-4" /> Properties</Button
    >
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Undo"
      title="Undo (⌘Z)"
      disabled={!canStage || undoStack.length === 0}
      onclick={undo}
      data-testid="pdf-edit-undo"><Undo2Icon class="size-4" /></Button
    >
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Redo"
      title="Redo (⇧⌘Z)"
      disabled={!canStage || redoStack.length === 0}
      onclick={redo}
      data-testid="pdf-edit-redo"><Redo2Icon class="size-4" /></Button
    >
    <span
      class="ml-1 text-xs text-muted-foreground"
      aria-live="polite"
      data-testid="pdf-edit-status">{busy === 'saving' ? 'Saving…' : dirty ? 'not saved' : ''}</span
    >
    <div class="ml-auto flex items-center gap-1">
      <Button variant="outline" size="sm" onclick={discard} data-testid="pdf-edit-discard"
        >{dirty ? 'Discard' : 'Done'}</Button
      >
      <Button
        size="sm"
        disabled={lock.kind !== 'held' || !dirty || busy !== null}
        onclick={save}
        data-testid="pdf-edit-save">Save</Button
      >
    </div>
  </div>

  {#if !author}
    <p
      class="border-b bg-muted/40 px-3 py-1.5 text-sm"
      role="status"
      data-testid="pdf-edit-no-author"
    >
      Annotating is off: notes are signed with your name, and this page doesn’t know it. You can
      still fill the form and set the properties.
    </p>
  {/if}
  {#if lock.kind === 'starting'}
    <p class="border-b px-3 py-2 text-sm text-muted-foreground" role="status">
      Opening for editing…
    </p>
  {:else if lock.kind === 'locked'}
    <div
      class="flex flex-wrap items-center gap-3 border-b bg-muted/40 px-4 py-3 text-sm"
      role="status"
      data-testid="pdf-edit-lock-banner"
    >
      <LockIcon class="size-4 text-muted-foreground" />
      <span class="flex-1"
        ><strong data-testid="pdf-edit-lock-holder">{lock.holder.name}</strong> is editing. You see the
        last saved version and can make changes once they are done.</span
      >
      <Button
        size="sm"
        variant="outline"
        onclick={() => begin(true)}
        data-testid="pdf-edit-takeover">Take over</Button
      >
    </div>
  {:else if lock.kind === 'lost'}
    <div
      class="flex flex-wrap items-center gap-3 border-b border-destructive/40 bg-destructive/5 px-4 py-3 text-sm"
      role="alert"
      data-testid="pdf-edit-lost-banner"
    >
      <CircleAlertIcon class="size-4 text-destructive" />
      <span class="flex-1"
        ><strong>{lock.holder?.name ?? 'Someone'}</strong> took over editing. Your changes are not saved;
        they are still here.</span
      >
      <Button
        size="sm"
        variant="outline"
        onclick={() => begin(true)}
        data-testid="pdf-edit-takeover">Take it back</Button
      >
    </div>
  {:else if lock.kind === 'stale'}
    <p
      class="border-b border-destructive/40 bg-destructive/5 px-4 py-3 text-sm"
      role="alert"
      data-testid="pdf-edit-stale"
    >
      This file changed since you opened it, so these changes can’t be saved over it. Discard to see
      the new version.
    </p>
  {:else if lock.kind === 'error'}
    <ErrorNotice
      class="border-b border-destructive/40 bg-destructive/10 px-4 py-2"
      testid="pdf-edit-lock-error"
      error={lock.error}
      agent={lock.agent}
      attempted="Taking the edit lock on this PDF"
    />
  {/if}
  {#if loadError}
    <ErrorNotice
      class="border-b border-destructive/40 bg-destructive/10 px-4 py-2"
      testid="pdf-edit-load-error"
      error={loadError.error}
      agent={loadError.agent}
      attempted="Reading this PDF’s annotations and form in the browser editor"
    />
  {/if}
  {#if notice}
    <ErrorNotice
      class="border-b border-destructive/40 bg-destructive/10 px-4 py-2"
      testid="pdf-edit-notice"
      error={notice.error}
      agent={notice.agent}
      attempted="Editing this PDF (staging, saving or opening its properties)"
    />
  {/if}
  {#if contents && mode === 'form'}
    {#if contents.form.kind === 'xfa-only'}
      <p class="border-b bg-muted/40 px-3 py-1.5 text-sm" role="status" data-testid="pdf-form-xfa">
        This is an XFA form, a format PDF 2.0 retired: it can’t be filled here. Fill it in a reader
        that supports XFA.
      </p>
    {:else if contents.form.kind === 'none'}
      <p class="border-b bg-muted/40 px-3 py-1.5 text-sm" role="status" data-testid="pdf-form-none">
        This PDF has no form fields.
      </p>
    {:else if contents.form.kind === 'hybrid'}
      <p class="border-b bg-muted/40 px-3 py-1.5 text-sm" role="status">
        This form also carries an XFA copy; saving fills the standard form and removes the XFA copy,
        so every reader shows the same values.
      </p>
    {/if}
    {#if staged.flatten}
      <p class="border-b bg-amber-50 px-3 py-1.5 text-sm text-amber-900" role="status">
        On save the form is flattened: the values become part of the pages and can no longer be
        changed as fields.
      </p>
    {/if}
  {/if}
  {#if contents && mode === 'annotate' && others > 0}
    <p
      class="border-b px-3 py-1 text-xs text-muted-foreground"
      role="status"
      data-testid="pdf-edit-others"
    >
      {others === 1 ? '1 annotation' : `${others} annotations`} of other kinds (links, stamps, …) {others ===
      1
        ? 'is'
        : 'are'} outlined while you edit and kept as they are.
    </p>
  {/if}

  <div class="pdf-edit-body">
    <div class="pdf-edit-scroll bg-muted/40" bind:this={scroller} data-testid="pdf-edit-pages">
      {#if contents}
        <div class="flex flex-col items-center gap-3 p-4">
          {#each base.pages as p, i (i)}
            <PdfEditPage
              bind:this={pageViews[i]}
              {lib}
              page={p}
              index={i}
              {scale}
              {mode}
              {tool}
              color={hexRgb(colour)}
              {opacity}
              {strokeWidth}
              annotations={annotations.filter((a) => a.page === i && !a.inReplyTo)}
              {selected}
              {fields}
              values={staged.fields}
              canStage={mode === 'annotate' ? canAnnotate : canStage}
              {measure}
              {onadd}
              onselect={onSelectAnnotation}
              {onmove}
              {onfield}
              onerror={(m) => (notice = { error: m, agent: null })}
            />
          {/each}
        </div>
      {:else if !loadError}
        <p class="p-6 text-sm text-muted-foreground">Reading the annotations and the form…</p>
      {/if}
    </div>
    {#if contents && author}
      <PdfComments
        {threads}
        {selected}
        canStage={canAnnotate}
        onselect={revealAnnotation}
        onreply={(id, text) => edit({ op: 'reply', key: newKey(), to: id, contents: text })}
        onreview={(id, reviewed) =>
          edit({ op: 'review', id, state: reviewed ? 'Completed' : 'None' })}
        oncontents={(id, text) => edit({ op: 'update', id, patch: { contents: text } })}
        ondelete={(id) => {
          edit({ op: 'delete', id })
          if (selected === id) selected = null
        }}
      />
    {/if}
  </div>
  {#if selectedAnnotation && mode === 'annotate'}
    <p class="sr-only" aria-live="polite">
      {kindLabel(selectedAnnotation.kind)} selected
    </p>
  {/if}
</div>

{#if propertiesOpen && PropertiesDialog && properties}
  {@const Dialog = PropertiesDialog}
  <Dialog
    {properties}
    {canStage}
    onapply={(patch) => stage({ ...staged, properties: { ...staged.properties, ...patch } })}
    onclose={() => (propertiesOpen = false)}
  />
{/if}

<style>
  .pdf-editor {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .pdf-edit-body {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .pdf-edit-scroll {
    flex: 1;
    min-width: 0;
    overflow: auto;
  }
</style>
