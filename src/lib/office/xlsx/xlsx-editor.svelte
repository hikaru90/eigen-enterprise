<script lang="ts">
  import type { OfficeViewerProps } from '../viewers'
  import ChartColumnIcon from '@lucide/svelte/icons/chart-column'
  import DownloadIcon from '@lucide/svelte/icons/download'
  import EyeOffIcon from '@lucide/svelte/icons/eye-off'
  import InfoIcon from '@lucide/svelte/icons/info'
  import LoaderIcon from '@lucide/svelte/icons/loader-circle'
  import PlusIcon from '@lucide/svelte/icons/plus'
  import Redo2Icon from '@lucide/svelte/icons/redo-2'
  import Undo2Icon from '@lucide/svelte/icons/undo-2'
  import { onMount, tick, untrack } from 'svelte'
  import { beforeNavigate, goto } from '$app/navigation'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import * as AlertDialog from '$lib/components/ui/alert-dialog'
  import { Button } from '$lib/components/ui/button'
  import type { LockHolder } from '$lib/drive/api'
  import { DriveApiError, driveApi } from '$lib/drive/api'
  import {
    createAutosave,
    LockLostError,
    type Autosave,
    type AutosaveState,
  } from '$lib/drive/autosave'
  import { parseClipboardBlock } from '$lib/drive/csv-grid'
  import { driveShownError } from '$lib/drive/shown-error'
  import type { ShownError } from '$lib/errors/agent-report'
  import { m } from '$lib/paraglide/messages.js'
  import { getLocale } from '$lib/paraglide/runtime'
  import { createOfficeEditSession } from '../edit-session'
  import { OFFICE_MIME } from '../kinds'
  import { OpcError } from '../ooxml/package'
  import { createSheetEditor, workbookNotes, type SheetEditor, type WorkbookNote } from './editor'
  import {
    displayValue,
    editText,
    FORMAT_CHOICES,
    formatCode,
    parseInput,
    type FormatChoiceId,
    type SheetLocale,
  } from './format'
  import { toShownFormula, XlsxLossError, type CellWrite, type Loss, type SheetOp } from './ops'
  import { cellKey, cellName, MAX_COLS, MAX_ROWS, rangeName, type Range } from './ref'
  import SheetGrid, { type GridCell, type Pos } from './sheet-grid.svelte'
  import { XlsxError } from './workbook'

  /**
   * Excel workbooks in the Drive: the sheet as a grid with its tabs, edited in
   * place — values, formulas (calculated as you type), number formats; add,
   * rename and delete sheets; insert and delete rows and columns; undo/redo.
   * Every change is an operation (./ops.ts) on the file itself, so what the
   * grid does not show (charts, pivot tables, comments, other formatting) is
   * written back untouched; what it does not show is listed above the grid,
   * and a change that would leave something in the wrong place asks first.
   *
   * Saving is the office editors' rule (W-6): the edit lock is taken with the
   * first change (someone else editing: their name, Take over), changes save
   * after a pause as one revision of the same file per session, the lock goes
   * after `idleMs` quiet. The save names the content it started from, so a
   * newer version saved elsewhere is never overwritten: the grid says so and
   * offers the newer version or a download of this one. View-only people see
   * the same grid without editing.
   */
  let {
    fileId,
    name,
    canEdit,
    heartbeatMs,
    onsaved,
    saveDelayMs = 1200,
    idleMs = 60_000,
  }: OfficeViewerProps & { saveDelayMs?: number; idleMs?: number } = $props()

  const locale: SheetLocale = getLocale() === 'de' ? 'de' : 'en'

  type View = { status: 'loading' } | ({ status: 'error' } & ShownError) | { status: 'ready' }
  let view = $state<View>({ status: 'loading' })
  type Mode =
    | { kind: 'open' }
    | { kind: 'watching'; holder: LockHolder }
    | { kind: 'lost'; holder: LockHolder | null }
    | { kind: 'conflict'; message: string }
  let mode = $state<Mode>({ kind: 'open' })
  /** Bumped on every change: what the grid and toolbar read. */
  let rev = $state(0)
  let sheet = $state('')
  let active = $state<Pos>({ row: 0, col: 0 })
  let anchor = $state<Pos>({ row: 0, col: 0 })
  let editing = $state(false)
  let draft = $state('')
  let extraRows = $state(0)
  let extraCols = $state(0)
  let notes = $state<WorkbookNote[]>([])
  let notesOpen = $state(false)
  let notice = $state<string | null>(null)
  let failure = $state<ShownError | null>(null)
  let save = $state<AutosaveState>({ status: 'saved', error: null, savedAt: null })
  let locking = $state(false)
  let renaming = $state<string | null>(null)
  let renameText = $state('')
  let confirm = $state<{ op: SheetOp; title: string; losses: Loss[] } | null>(null)
  let grid = $state<ReturnType<typeof SheetGrid> | null>(null)

  let editor: SheetEditor | null = null
  /** The bytes as the server has them (last loaded or saved) and their SHA-256 (the save's base). */
  let base: Uint8Array | null = null
  let baseSha: string | null = null
  let lostHolder: LockHolder | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let lockWait: Promise<boolean> | null = null

  const session = createOfficeEditSession({
    fileId: untrack(() => fileId),
    heartbeatMs: untrack(() => heartbeatMs),
    onLost: (holder) => lose(holder),
  })
  let autosave: Autosave = makeAutosave()

  function makeAutosave(): Autosave {
    return createAutosave({
      delayMs: untrack(() => saveDelayMs),
      onState: (s) => (save = s),
      onLost: () => lose(lostHolder),
      async save() {
        const bytes = editor!.toBytes()
        try {
          const file = await session.save(bytes, baseSha ? { base: baseSha } : undefined)
          base = bytes
          baseSha = await sha256(bytes)
          onsaved?.(file)
        } catch (err) {
          if (err instanceof DriveApiError && err.code === 'conflict') {
            conflicted(err.message)
            throw new LockLostError(err.message)
          }
          throw err
        }
      },
    })
  }

  async function sha256(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  // ---------------------------------------------------------------------------
  // What is on screen

  const ready = $derived(view.status === 'ready')
  const editable = $derived(canEdit && ready && mode.kind === 'open')
  const sheets = $derived.by(() => {
    void rev
    return editor && ready ? editor.wb.sheets() : []
  })
  const info = $derived(sheets.find((s) => s.name === sheet) ?? null)
  const data = $derived.by(() => {
    void rev
    return editor && info?.kind === 'worksheet' ? editor.wb.sheet(info.name) : null
  })
  const rows = $derived(Math.min(MAX_ROWS, Math.max((data?.maxRow ?? 0) + 31, 60) + extraRows))
  const cols = $derived(Math.min(MAX_COLS, Math.max((data?.maxCol ?? 0) + 6, 26) + extraCols))
  const sel = $derived<Range>({
    top: Math.min(active.row, anchor.row),
    bottom: Math.max(active.row, anchor.row),
    left: Math.min(active.col, anchor.col),
    right: Math.max(active.col, anchor.col),
  })
  const activeRef = $derived(cellName(active))
  const history = $derived.by(() => {
    void rev
    return { undo: editor?.canUndo() ?? false, redo: editor?.canRedo() ?? false }
  })

  const colWidth = $derived.by(() => {
    void rev
    const d = data
    return (c: number) => {
      if (!d) return 64
      const col = d.cols.find((x) => c >= x.min && c <= x.max)
      if (col?.hidden) return 0
      return col?.widthPx ?? d.defaultColPx
    }
  })
  const rowHeight = $derived.by(() => {
    void rev
    const d = data
    return (r: number) => {
      if (!d) return 20
      const row = d.rows.get(r)
      if (row?.hidden) return 0
      return row?.heightPx ?? d.defaultRowPx
    }
  })

  const cellAt = $derived.by(() => {
    void rev
    const d = data
    const ed = editor
    if (!d || !ed) return () => null
    const styles = ed.wb.styles()
    const calc = ed.calc()
    const date1904 = ed.wb.date1904
    return (r: number, c: number): GridCell | null => {
      const cell = d.cells.get(cellKey(r, c))
      const out = calc.cell(d.info.name, r, c)
      // An empty cell can still show a value: a dynamic array spilled into it.
      if (!cell && out.value === null && !out.kept) return null
      const st = styles.xf(cell?.style ?? 0)
      const shown = displayValue(out.value, formatCode(st.numFmtId, st.numFmt, locale), locale, {
        date1904,
      })
      const v = out.value
      const natural =
        typeof v === 'number'
          ? 'right'
          : typeof v === 'boolean' || (typeof v === 'object' && v !== null)
            ? 'center'
            : 'left'
      const h = st.horizontal
      const align =
        h === 'center' || h === 'centerContinuous'
          ? 'center'
          : h === 'right'
            ? 'right'
            : h === 'left'
              ? 'left'
              : natural
      const css: string[] = []
      if (st.font.bold) css.push('font-weight: 600')
      if (st.font.italic) css.push('font-style: italic')
      const deco = [st.font.underline ? 'underline' : '', st.font.strike ? 'line-through' : '']
        .filter(Boolean)
        .join(' ')
      if (deco) css.push(`text-decoration: ${deco}`)
      const color = shown.color ?? st.font.color
      // Black text (Excel's default) is left to the theme so dark mode stays readable, unless the cell has a fill.
      if (color && (st.fill || color.toUpperCase() !== '#000000')) css.push(`color: ${color}`)
      else if (st.fill) css.push('color: #000')
      if (st.fill) css.push(`background-color: ${st.fill}`)
      if (st.font.sizePt && st.font.sizePt !== 11)
        css.push(`font-size: ${Math.round(st.font.sizePt * 1.27)}px`)
      if (st.indent) css.push(`padding-left: ${4 + st.indent * 9}px`)
      return {
        text: shown.text,
        align,
        css: css.join('; '),
        wrap: st.wrap,
        kept: out.kept ? out.reason : null,
        unreadFormat: !!shown.unreadFormat,
      }
    }
  })

  /** The active cell's content as the formula bar shows it. */
  const barText = $derived.by(() => {
    void rev
    if (!data || !editor) return ''
    return contentText(active.row, active.col)
  })

  const currentFormat = $derived.by<FormatChoiceId | 'custom'>(() => {
    void rev
    if (!data || !editor) return 'general'
    const cell = data.cells.get(cellKey(active.row, active.col))
    const st = editor.wb.styles().xf(cell?.style ?? 0)
    return FORMAT_CHOICES.find((f) => f.code === st.numFmt)?.id ?? 'custom'
  })

  function contentText(r: number, c: number): string {
    const cell = data?.cells.get(cellKey(r, c))
    if (!cell || !editor) return ''
    const st = editor.wb.styles().xf(cell.style)
    return editText(
      cell.value,
      cell.formula === null ? null : toShownFormula(cell.formula),
      formatCode(st.numFmtId, st.numFmt, locale),
      locale,
      editor.wb.date1904,
    )
  }

  const formatLabel = (id: FormatChoiceId): string =>
    ({
      general: m.drive_sheet_format_general(),
      number: m.drive_sheet_format_number(),
      integer: m.drive_sheet_format_integer(),
      percent: m.drive_sheet_format_percent(),
      currency_eur: m.drive_sheet_format_currency_eur(),
      currency_usd: m.drive_sheet_format_currency_usd(),
      date: m.drive_sheet_format_date(),
      date_iso: m.drive_sheet_format_date_iso(),
      time: m.drive_sheet_format_time(),
      datetime: m.drive_sheet_format_datetime(),
      text: m.drive_sheet_format_text(),
    })[id]

  function noteText(n: WorkbookNote): string {
    switch (n.kind) {
      case 'charts':
        return m.drive_sheet_note_charts({ count: n.count })
      case 'drawings':
        return m.drive_sheet_note_drawings({ count: n.count })
      case 'pivot_tables':
        return m.drive_sheet_note_pivots({ count: n.count })
      case 'comments':
        return m.drive_sheet_note_comments({ count: n.count })
      case 'tables':
        return m.drive_sheet_note_tables({ count: n.count })
      case 'conditional_formats':
        return m.drive_sheet_note_conditional({ count: n.count })
      case 'data_validations':
        return m.drive_sheet_note_validations({ count: n.count })
      case 'hidden_sheets':
        return m.drive_sheet_note_hidden({ count: n.count, names: n.detail ?? '' })
      case 'chart_sheets':
        return m.drive_sheet_note_chart_sheets({ count: n.count })
      case 'formulas_kept':
        return m.drive_sheet_note_kept({ count: n.count, what: n.detail ?? '' })
    }
  }

  function lossText(l: Loss): string {
    const count = l.count
    switch (l.feature) {
      case 'tables':
        return m.drive_sheet_loss_tables({ count })
      case 'pivot_tables':
        return m.drive_sheet_loss_pivots({ count })
      case 'drawings':
        return m.drive_sheet_loss_drawings({ count })
      case 'comments':
      case 'threaded_comments':
        return m.drive_sheet_loss_comments({ count })
      case 'controls':
        return m.drive_sheet_loss_controls({ count })
      case 'extensions':
        return m.drive_sheet_loss_extensions({ count })
      case 'charts':
        return m.drive_sheet_loss_charts({ count })
      case 'pivot_sources':
        return m.drive_sheet_loss_pivot_sources({ count })
      case 'formulas_ref_error':
        return m.drive_sheet_loss_formulas({ count })
      case 'names_ref_error':
        return m.drive_sheet_loss_names({ count })
    }
  }

  // ---------------------------------------------------------------------------
  // Loading

  onMount(() => {
    void load()
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (autosave.unsaved() === null && save.status !== 'saving') return
      void autosave.flush()
      event.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      clearIdle()
      if (session.held()) void autosave.flush().then(() => session.stop())
    }
  })

  // In-app navigation waits for the last save, then continues.
  let leaving = false
  beforeNavigate((nav) => {
    if (leaving || autosave.unsaved() === null) return
    const to = nav.to?.url
    if (nav.type === 'leave' || !to || nav.type === 'popstate') {
      void autosave.flush()
      return
    }
    nav.cancel()
    leaving = true
    void autosave.flush().then(async () => {
      try {
        if (save.status === 'error' && !window.confirm(m.drive_sheet_leave_unsaved())) return
        // eslint-disable-next-line svelte/no-navigation-without-resolve -- the navigation the person already started (an app URL SvelteKit resolved)
        await goto(to.href, { invalidateAll: true })
      } finally {
        leaving = false
      }
    })
  })

  async function load() {
    try {
      await open(await driveApi.readBytes(fileId))
    } catch (err) {
      view = { status: 'error', ...shown(err) }
    }
  }

  function shown(err: unknown): ShownError {
    if (err instanceof XlsxError)
      return { error: m.drive_sheet_cannot_open({ why: err.message }), agent: null }
    if (err instanceof OpcError)
      return { error: m.drive_sheet_cannot_open({ why: err.message }), agent: null }
    return driveShownError(err)
  }

  /** Opens bytes as the workbook on screen (first load, a newer version, take over). */
  async function open(bytes: Uint8Array) {
    const next = createSheetEditor(bytes)
    editor = next
    base = bytes
    baseSha = await sha256(bytes)
    const all = next.wb.sheets()
    if (!all.some((s) => s.name === sheet))
      sheet = (all.find((s) => s.state === 'visible') ?? all[0]!).name
    notes = workbookNotes(next)
    editing = false
    extraRows = 0
    extraCols = 0
    view = { status: 'ready' }
    rev++
  }

  // ---------------------------------------------------------------------------
  // The edit lock

  /** The lock before a change: taken on the first one (and again after an idle release). */
  async function ensureLock(): Promise<boolean> {
    if (mode.kind !== 'open' || !canEdit) return false
    if (session.held()) return true
    lockWait ??= (async () => {
      locking = true
      try {
        const v = await session.start()
        if (v.state === 'held') {
          // Someone may have saved since this copy was loaded: never save over that.
          const now = await driveApi.readBytes(fileId)
          if (base && (await sha256(now)) !== baseSha) {
            await open(now)
            notice = m.drive_sheet_reloaded()
            return false
          }
          return true
        }
        if (v.state === 'locked') {
          grid?.finishEdit(false)
          mode = { kind: 'watching', holder: v.holder }
          return false
        }
        failure = { error: m.drive_sheet_lock_failed(), agent: null }
        return false
      } catch (err) {
        failure = driveShownError(err)
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
    if (mode.kind === 'lost' || mode.kind === 'conflict') return
    clearIdle()
    autosave.stop()
    grid?.finishEdit(false)
    mode = { kind: 'lost', holder: lostHolder }
  }

  /** The file changed elsewhere since this copy was opened: nothing more is saved over it. */
  function conflicted(message: string) {
    clearIdle()
    grid?.finishEdit(false)
    mode = { kind: 'conflict', message }
    void session.stop()
  }

  async function takeOver() {
    notice = null
    failure = null
    locking = true
    try {
      const v = await session.start({ takeover: true })
      if (v.state !== 'held') {
        failure = { error: m.drive_sheet_lock_failed(), agent: null }
        return
      }
      lostHolder = null
      await open(await driveApi.readBytes(fileId))
      autosave = makeAutosave()
      save = autosave.state()
      mode = { kind: 'open' }
      touchIdle()
    } catch (err) {
      failure = driveShownError(err)
    } finally {
      locking = false
    }
  }

  /** After a conflict: the newer version from the server, editing again. */
  async function reloadNewest() {
    failure = null
    try {
      await open(await driveApi.readBytes(fileId))
      autosave = makeAutosave()
      save = autosave.state()
      mode = { kind: 'open' }
    } catch (err) {
      failure = driveShownError(err)
    }
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
    if (mode.kind !== 'open' || !session.held()) return
    if (editing) return touchIdle()
    await autosave.flush()
    if (mode.kind !== 'open' || autosave.unsaved() !== null || save.status !== 'saved')
      return touchIdle()
    await session.stop()
  }

  function downloadCopy() {
    if (!editor) return
    const url = URL.createObjectURL(
      new Blob([editor.toBytes().slice().buffer as ArrayBuffer], { type: OFFICE_MIME.xlsx }),
    )
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  // ---------------------------------------------------------------------------
  // Changes

  /** Applies an operation under the edit lock; one with losses asks first. */
  async function change(op: SheetOp, opts: { acceptLosses?: boolean } = {}): Promise<boolean> {
    if (!editor) return false
    notice = null
    failure = null
    if (!opts.acceptLosses) {
      let losses: Loss[]
      try {
        losses = editor.losses(op)
      } catch (err) {
        failure = shown(err)
        return false
      }
      if (losses.length > 0 || op.op === 'delete_sheet') {
        confirm = { op, losses, title: confirmTitle(op) }
        return false
      }
    }
    if (!(await ensureLock())) return false
    try {
      const result = editor.apply(op, { acceptLosses: true })
      if (result.focus) sheet = result.focus
    } catch (err) {
      failure =
        err instanceof XlsxLossError || err instanceof XlsxError
          ? { error: err.message, agent: null }
          : shown(err)
      return false
    }
    rev++
    autosave.change(String(editor.version()))
    touchIdle()
    return true
  }

  function confirmTitle(op: SheetOp): string {
    switch (op.op) {
      case 'delete_sheet':
        return m.drive_sheet_confirm_delete_sheet({ name: op.sheet })
      case 'insert_rows':
        return m.drive_sheet_confirm_insert_rows({ count: op.count })
      case 'delete_rows':
        return m.drive_sheet_confirm_delete_rows({ count: op.count })
      case 'insert_columns':
        return m.drive_sheet_confirm_insert_columns({ count: op.count })
      case 'delete_columns':
        return m.drive_sheet_confirm_delete_columns({ count: op.count })
      default:
        return m.drive_sheet_confirm_change()
    }
  }

  async function confirmed() {
    const c = confirm
    confirm = null
    if (c) await change(c.op, { acceptLosses: true })
  }

  function writeOf(pos: Pos, text: string): CellWrite {
    const ref = cellName(pos)
    const p = parseInput(text, locale)
    if (p.kind === 'formula') return { ref, formula: p.formula }
    return p.format ? { ref, value: p.value, impliedFormat: p.format } : { ref, value: p.value }
  }

  async function commitCell(pos: Pos, text: string) {
    if (!data || text === contentText(pos.row, pos.col)) return
    await change({ op: 'set_cells', sheet, cells: [writeOf(pos, text)] })
  }

  async function clearRange(range: Range) {
    if (!data) return
    const cells: CellWrite[] = []
    for (const cell of data.cells.values())
      if (
        cell.row >= range.top &&
        cell.row <= range.bottom &&
        cell.col >= range.left &&
        cell.col <= range.right &&
        (cell.value !== null || cell.formula !== null) &&
        !cell.inArrayOf
      )
        cells.push({ ref: cellName(cell), value: null })
    if (cells.length) await change({ op: 'set_cells', sheet, cells })
  }

  async function pasteAt(pos: Pos, text: string) {
    const block = parseClipboardBlock(text)
    const cells: CellWrite[] = []
    block.forEach((line, r) =>
      line.forEach((t, c) => cells.push(writeOf({ row: pos.row + r, col: pos.col + c }, t))),
    )
    if (cells.length) await change({ op: 'set_cells', sheet, cells })
  }

  function copyText(range: Range): string {
    const out: string[] = []
    for (let r = range.top; r <= range.bottom; r++) {
      const line: string[] = []
      for (let c = range.left; c <= range.right; c++) {
        const t = cellAt(r, c)?.text ?? ''
        line.push(/[\t\n"]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t)
      }
      out.push(line.join('\t'))
    }
    return out.join('\n')
  }

  async function setFormat(id: string) {
    const choice = FORMAT_CHOICES.find((f) => f.id === id)
    if (!choice) return
    await change({ op: 'set_format', sheet, range: rangeName(sel), format: choice.code })
    grid?.focus()
  }

  async function insertRows(where: 'above' | 'below') {
    const count = sel.bottom - sel.top + 1
    await change({
      op: 'insert_rows',
      sheet,
      at: where === 'above' ? sel.top : sel.bottom + 1,
      count,
    })
  }
  async function deleteRows() {
    await change({ op: 'delete_rows', sheet, at: sel.top, count: sel.bottom - sel.top + 1 })
  }
  async function insertColumns(where: 'left' | 'right') {
    const count = sel.right - sel.left + 1
    await change({
      op: 'insert_columns',
      sheet,
      at: where === 'left' ? sel.left : sel.right + 1,
      count,
    })
  }
  async function deleteColumns() {
    await change({ op: 'delete_columns', sheet, at: sel.left, count: sel.right - sel.left + 1 })
  }

  async function undo() {
    if (!editor?.canUndo() || !(await ensureLock())) return
    const r = editor.undo()
    if (r?.focus && editor.wb.findSheet(r.focus)) sheet = editor.wb.findSheet(r.focus)!.name
    afterHistory()
  }
  async function redo() {
    if (!editor?.canRedo() || !(await ensureLock())) return
    const r = editor.redo()
    if (r?.focus && editor.wb.findSheet(r.focus)) sheet = editor.wb.findSheet(r.focus)!.name
    afterHistory()
  }
  function afterHistory() {
    if (!editor) return
    if (!editor.wb.findSheet(sheet)) sheet = editor.wb.sheets()[0]!.name
    rev++
    autosave.change(String(editor.version()))
    touchIdle()
  }

  function onRootKeydown(event: KeyboardEvent) {
    const t = event.target
    if (
      t instanceof HTMLInputElement ||
      t instanceof HTMLTextAreaElement ||
      t instanceof HTMLSelectElement
    )
      return
    const mod = event.metaKey || event.ctrlKey
    if (!mod || !editable) return
    const key = event.key.toLowerCase()
    if (key === 'z') {
      event.preventDefault()
      void (event.shiftKey ? redo() : undo())
    } else if (key === 'y') {
      event.preventDefault()
      void redo()
    }
  }

  // ---------------------------------------------------------------------------
  // Formula bar

  function onFormulaFocus() {
    if (!editable) return
    if (!editing) {
      draft = barText
      editing = true
    }
  }

  function onFormulaKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault()
      grid?.finishEdit(true, 'down')
    } else if (event.key === 'Escape') {
      event.preventDefault()
      grid?.finishEdit(false)
    } else if (event.key === 'Tab') {
      event.preventDefault()
      grid?.finishEdit(true, 'right')
    }
  }

  // ---------------------------------------------------------------------------
  // Sheet tabs

  async function pickSheet(n: string) {
    if (editing) grid?.finishEdit(true)
    sheet = n
    active = { row: 0, col: 0 }
    anchor = { row: 0, col: 0 }
    extraRows = 0
    extraCols = 0
    await tick()
    grid?.focus()
  }

  async function addSheet() {
    if (!editor) return
    const taken = new Set(editor.wb.sheets().map((s) => s.name.toLowerCase()))
    let n = editor.wb.sheets().length + 1
    while (taken.has(m.drive_sheet_default_name({ n }).toLowerCase())) n++
    if (await change({ op: 'add_sheet', name: m.drive_sheet_default_name({ n }) })) {
      active = { row: 0, col: 0 }
      anchor = { row: 0, col: 0 }
    }
  }

  async function startRename(n: string) {
    if (!editable) return
    renaming = n
    renameText = n
    await tick()
    const el = document.querySelector<HTMLInputElement>('[data-testid="xlsx-tab-rename"]')
    el?.focus()
    el?.select()
  }

  async function finishRename(commit: boolean) {
    const from = renaming
    renaming = null
    if (!commit || !from || renameText.trim() === from) return
    await change({ op: 'rename_sheet', sheet: from, name: renameText })
  }

  function onRenameKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault()
      void finishRename(true)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      void finishRename(false)
    }
  }

  const saveLabel = $derived(
    save.status === 'saving'
      ? m.drive_sheet_saving()
      : save.status === 'dirty'
        ? m.drive_sheet_unsaved()
        : save.status === 'error'
          ? m.drive_sheet_save_failed()
          : save.savedAt
            ? m.drive_sheet_saved()
            : '',
  )

  const btn =
    'inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40'
</script>

{#if view.status === 'loading'}
  <div
    class="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
    data-testid="xlsx-loading"
  >
    <LoaderIcon class="size-4 animate-spin" aria-hidden="true" />
    {m.drive_sheet_opening({ name })}
  </div>
{:else if view.status === 'error'}
  <ErrorNotice
    class="m-6"
    testid="xlsx-error"
    error={view.error}
    agent={view.agent}
    attempted={m.drive_sheet_attempt_open({ name })}
  />
{:else}
  <div
    class="flex min-h-[60vh] min-w-0 flex-1 flex-col"
    data-testid="xlsx-editor"
    role="presentation"
    onkeydown={onRootKeydown}
  >
    {#if editable}
      <div
        class="flex flex-wrap items-center gap-1 border-b px-2 py-1"
        role="toolbar"
        aria-label={m.drive_sheet_toolbar()}
        data-testid="xlsx-toolbar"
      >
        <button
          type="button"
          class={btn}
          onclick={() => void undo()}
          disabled={!history.undo}
          title={m.drive_sheet_undo()}
          aria-label={m.drive_sheet_undo()}
          data-testid="xlsx-undo"><Undo2Icon class="size-4" aria-hidden="true" /></button
        >
        <button
          type="button"
          class={btn}
          onclick={() => void redo()}
          disabled={!history.redo}
          title={m.drive_sheet_redo()}
          aria-label={m.drive_sheet_redo()}
          data-testid="xlsx-redo"><Redo2Icon class="size-4" aria-hidden="true" /></button
        >
        <span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
        <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span class="sr-only sm:not-sr-only">{m.drive_sheet_format()}</span>
          <select
            class="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            value={currentFormat}
            onchange={(e) => void setFormat(e.currentTarget.value)}
            data-testid="xlsx-format"
          >
            {#if currentFormat === 'custom'}<option value="custom" disabled
                >{m.drive_sheet_format_custom()}</option
              >{/if}
            {#each FORMAT_CHOICES as f (f.id)}<option value={f.id}>{formatLabel(f.id)}</option
              >{/each}
          </select>
        </label>
        <span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
        <button
          type="button"
          class={btn}
          onclick={() => void insertRows('above')}
          data-testid="xlsx-insert-row-above">{m.drive_sheet_insert_row_above()}</button
        >
        <button
          type="button"
          class={btn}
          onclick={() => void insertRows('below')}
          data-testid="xlsx-insert-row-below">{m.drive_sheet_insert_row_below()}</button
        >
        <button
          type="button"
          class={btn}
          onclick={() => void deleteRows()}
          data-testid="xlsx-delete-rows">{m.drive_sheet_delete_rows()}</button
        >
        <span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
        <button
          type="button"
          class={btn}
          onclick={() => void insertColumns('left')}
          data-testid="xlsx-insert-col-left">{m.drive_sheet_insert_col_left()}</button
        >
        <button
          type="button"
          class={btn}
          onclick={() => void insertColumns('right')}
          data-testid="xlsx-insert-col-right">{m.drive_sheet_insert_col_right()}</button
        >
        <button
          type="button"
          class={btn}
          onclick={() => void deleteColumns()}
          data-testid="xlsx-delete-cols">{m.drive_sheet_delete_cols()}</button
        >
        <span
          class="ml-auto flex items-center gap-1.5 px-2 text-xs text-muted-foreground"
          role="status"
          data-testid="xlsx-save-state"
        >
          {#if locking || save.status === 'saving'}<LoaderIcon
              class="size-3.5 animate-spin"
              aria-hidden="true"
            />{/if}
          {saveLabel}
          {#if save.status === 'error'}
            <button type="button" class="underline" onclick={() => void autosave.retry()}
              >{m.drive_sheet_retry()}</button
            >
          {/if}
        </span>
      </div>
    {/if}

    {#if mode.kind === 'watching'}
      <div
        class="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2 text-sm"
        role="status"
        data-testid="xlsx-watching"
      >
        <span>{m.drive_sheet_someone_editing({ name: mode.holder.name })}</span>
        <Button
          size="sm"
          variant="outline"
          onclick={() => void takeOver()}
          disabled={locking}
          data-testid="xlsx-take-over">{m.drive_sheet_take_over()}</Button
        >
      </div>
    {:else if mode.kind === 'lost'}
      <div
        class="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2 text-sm"
        role="status"
        data-testid="xlsx-lost"
      >
        <span
          >{mode.holder
            ? m.drive_sheet_taken_over({ name: mode.holder.name })
            : m.drive_sheet_lock_lost()}</span
        >
        <Button size="sm" variant="outline" onclick={downloadCopy}
          ><DownloadIcon class="size-4" aria-hidden="true" />
          {m.drive_sheet_download_mine()}</Button
        >
        <Button size="sm" variant="outline" onclick={() => void takeOver()} disabled={locking}
          >{m.drive_sheet_take_back()}</Button
        >
      </div>
    {:else if mode.kind === 'conflict'}
      <div
        class="flex flex-wrap items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
        role="alert"
        data-testid="xlsx-conflict"
      >
        <span>{m.drive_sheet_conflict()}</span>
        <Button
          size="sm"
          variant="outline"
          onclick={() => void reloadNewest()}
          data-testid="xlsx-reload">{m.drive_sheet_open_newest()}</Button
        >
        <Button size="sm" variant="outline" onclick={downloadCopy}
          ><DownloadIcon class="size-4" aria-hidden="true" />
          {m.drive_sheet_download_mine()}</Button
        >
      </div>
    {/if}
    {#if notice}
      <p
        class="border-b px-3 py-2 text-sm text-muted-foreground"
        role="status"
        data-testid="xlsx-notice"
      >
        {notice}
      </p>
    {/if}
    {#if failure}
      <ErrorNotice
        class="border-b border-destructive/40 bg-destructive/10 px-3 py-2"
        testid="xlsx-failure"
        error={failure.error}
        agent={failure.agent}
        attempted={m.drive_sheet_attempt_change({ name })}
      />
    {/if}
    {#if notes.length > 0}
      <div class="border-b px-3 py-1.5 text-xs text-muted-foreground" data-testid="xlsx-notes">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 hover:text-foreground"
          aria-expanded={notesOpen}
          onclick={() => (notesOpen = !notesOpen)}
        >
          <InfoIcon class="size-3.5" aria-hidden="true" />
          {m.drive_sheet_notes_summary({ count: notes.length })}
        </button>
        {#if notesOpen}
          <ul class="mt-1 list-disc pl-6" data-testid="xlsx-notes-list">
            {#each notes as n (n.kind)}<li>{noteText(n)}</li>{/each}
          </ul>
        {/if}
      </div>
    {/if}

    <!-- Formula bar -->
    <div class="flex items-center gap-2 border-b px-2 py-1">
      <span
        class="w-16 shrink-0 rounded border border-border px-1.5 py-0.5 text-center font-mono text-xs tabular-nums"
        data-testid="xlsx-ref"
        >{sel.top === sel.bottom && sel.left === sel.right ? activeRef : rangeName(sel)}</span
      >
      <span class="font-serif text-sm text-muted-foreground italic" aria-hidden="true">fx</span>
      <input
        value={editing ? draft : barText}
        readonly={!editable}
        class="h-7 min-w-0 flex-1 rounded border border-input bg-background px-2 font-mono text-sm"
        aria-label={m.drive_sheet_formula_bar({ ref: activeRef })}
        spellcheck="false"
        onfocus={onFormulaFocus}
        oninput={(e) => (draft = e.currentTarget.value)}
        onkeydown={onFormulaKeydown}
        data-testid="xlsx-formula"
      />
    </div>

    {#if info && info.kind !== 'worksheet'}
      <div
        class="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-sm text-muted-foreground"
        data-testid="xlsx-chart-sheet"
      >
        <ChartColumnIcon class="size-8" aria-hidden="true" />
        <p>{m.drive_sheet_chart_sheet({ name: info.name })}</p>
      </div>
    {:else if data}
      <SheetGrid
        bind:this={grid}
        bind:active
        bind:anchor
        bind:editing
        bind:draft
        {rows}
        {cols}
        {colWidth}
        {rowHeight}
        {cellAt}
        merges={data.merges}
        {rev}
        {editable}
        label={m.drive_sheet_grid_label({ sheet: info?.name ?? '' })}
        editTextOf={contentText}
        oncommit={(pos, text) => void commitCell(pos, text)}
        onclear={(r) => void clearRange(r)}
        onpaste={(pos, text) => void pasteAt(pos, text)}
        {copyText}
        onreach={(axis) => (axis === 'row' ? (extraRows += 100) : (extraCols += 10))}
        onblocked={() =>
          (notice = canEdit
            ? mode.kind === 'watching'
              ? m.drive_sheet_someone_editing({ name: mode.holder.name })
              : notice
            : m.drive_sheet_view_only())}
      />
    {/if}

    <!-- Sheet tabs -->
    <div
      class="flex items-center gap-0.5 overflow-x-auto border-t bg-muted/30 px-1 py-1"
      role="tablist"
      aria-label={m.drive_sheet_tabs()}
      data-testid="xlsx-tabs"
    >
      {#each sheets as s (s.part)}
        {#if renaming === s.name}
          <input
            bind:value={renameText}
            class="h-7 w-36 rounded border border-primary bg-background px-2 text-sm"
            aria-label={m.drive_sheet_rename_label({ name: s.name })}
            onkeydown={onRenameKeydown}
            onblur={() => void finishRename(true)}
            data-testid="xlsx-tab-rename"
          />
        {:else}
          <button
            type="button"
            role="tab"
            aria-selected={s.name === sheet}
            class="inline-flex h-7 shrink-0 items-center gap-1 rounded px-2.5 text-sm {s.name ===
            sheet
              ? 'bg-background font-medium text-foreground shadow-sm'
              : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'} {s.state !==
            'visible'
              ? 'italic'
              : ''}"
            onclick={() => void pickSheet(s.name)}
            ondblclick={() => void startRename(s.name)}
            title={s.state !== 'visible'
              ? m.drive_sheet_hidden_tab()
              : editable
                ? m.drive_sheet_tab_hint()
                : undefined}
            data-testid="xlsx-tab"
          >
            {#if s.state !== 'visible'}<EyeOffIcon class="size-3.5" aria-hidden="true" />{/if}
            {#if s.kind !== 'worksheet'}<ChartColumnIcon class="size-3.5" aria-hidden="true" />{/if}
            {s.name}
          </button>
        {/if}
      {/each}
      {#if editable}
        <button
          type="button"
          class="{btn} h-7"
          onclick={() => void addSheet()}
          title={m.drive_sheet_add()}
          aria-label={m.drive_sheet_add()}
          data-testid="xlsx-add-sheet"><PlusIcon class="size-4" aria-hidden="true" /></button
        >
        {#if info}
          <span class="mx-1 h-4 w-px bg-border" aria-hidden="true"></span>
          <button
            type="button"
            class="{btn} h-7 text-xs"
            onclick={() => void startRename(info.name)}
            data-testid="xlsx-rename-sheet">{m.drive_sheet_rename()}</button
          >
          <button
            type="button"
            class="{btn} h-7 text-xs"
            onclick={() => void change({ op: 'delete_sheet', sheet: info.name })}
            data-testid="xlsx-delete-sheet">{m.drive_sheet_delete()}</button
          >
        {/if}
      {:else if !canEdit}
        <span class="ml-auto px-2 text-xs text-muted-foreground" data-testid="xlsx-view-only"
          >{m.drive_sheet_view_only()}</span
        >
      {/if}
    </div>
  </div>
{/if}

<AlertDialog.Root
  open={confirm !== null}
  onOpenChange={(open) => {
    if (!open) confirm = null
  }}
>
  <AlertDialog.Content class="max-w-md" data-testid="xlsx-confirm">
    <AlertDialog.Header>
      <AlertDialog.Title>{confirm?.title ?? ''}</AlertDialog.Title>
      <AlertDialog.Description>
        {#if confirm && confirm.losses.length > 0}
          {m.drive_sheet_losses_intro()}
        {:else}
          {m.drive_sheet_undo_hint()}
        {/if}
      </AlertDialog.Description>
    </AlertDialog.Header>
    {#if confirm && confirm.losses.length > 0}
      <ul class="list-disc pl-5 text-sm" data-testid="xlsx-losses">
        {#each confirm.losses as l (l.feature)}<li>{lossText(l)}</li>{/each}
      </ul>
    {/if}
    <AlertDialog.Footer>
      <AlertDialog.Cancel data-testid="xlsx-confirm-cancel"
        >{m.drive_sheet_cancel()}</AlertDialog.Cancel
      >
      <Button
        variant={confirm?.op.op === 'delete_sheet' ? 'destructive' : 'default'}
        onclick={() => void confirmed()}
        data-testid="xlsx-confirm-ok">{m.drive_sheet_go_ahead()}</Button
      >
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
