<script lang="ts">
  import type { OfficeViewerProps } from '../viewers'
  import type { ClearWhat, MergeMode } from './cells-edit'
  import type { ChartPlacement } from './chart-anchor'
  import type { ChartPosition } from './chart-ops'
  import type { StylePatch } from './format-cells'
  import ArrowDownAZIcon from '@lucide/svelte/icons/arrow-down-a-z'
  import ArrowDownZAIcon from '@lucide/svelte/icons/arrow-down-z-a'
  import ChartColumnIcon from '@lucide/svelte/icons/chart-column'
  import CopyIcon from '@lucide/svelte/icons/copy'
  import DownloadIcon from '@lucide/svelte/icons/download'
  import FunnelIcon from '@lucide/svelte/icons/funnel'
  import InfoIcon from '@lucide/svelte/icons/info'
  import LoaderIcon from '@lucide/svelte/icons/loader-circle'
  import PlusIcon from '@lucide/svelte/icons/plus'
  import Redo2Icon from '@lucide/svelte/icons/redo-2'
  import ScissorsIcon from '@lucide/svelte/icons/scissors'
  import SearchIcon from '@lucide/svelte/icons/search'
  import SheetIcon from '@lucide/svelte/icons/sheet'
  import TableIcon from '@lucide/svelte/icons/table'
  import Undo2Icon from '@lucide/svelte/icons/undo-2'
  import { onMount, tick, untrack } from 'svelte'
  import { beforeNavigate, goto } from '$app/navigation'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import * as AlertDialog from '$lib/components/ui/alert-dialog'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import type { LockHolder } from '$lib/drive/api'
  import { DriveApiError, driveApi } from '$lib/drive/api'
  import {
    createAutosave,
    LockLostError,
    type Autosave,
    type AutosaveState,
  } from '$lib/drive/autosave'
  import { driveShownError } from '$lib/drive/shown-error'
  import type { ShownError } from '$lib/errors/agent-report'
  import { m } from '$lib/paraglide/messages.js'
  import { getLocale } from '$lib/paraglide/runtime'
  import { createOfficeEditSession } from '../edit-session'
  import { OFFICE_MIME } from '../kinds'
  import { OpcError } from '../ooxml/package'
  import { readClip, type Clip, type PasteMode } from './clip'
  import { clipFromClipboard, clipToHtml, clipToTsv } from './clip-interop'
  import { chartsOn } from './chart-anchor'
  import ChartDialog from './chart-dialog.svelte'
  import ChartOverlay from './chart-overlay.svelte'
  import ChartView from './chart-view.svelte'
  import { createSheetEditor, workbookNotes, type SheetEditor, type WorkbookNote } from './editor'
  import { fillDownTo, fillShortcutRange } from './fill'
  import {
    autoFilterOf,
    columnChoices,
    currentRegion,
    sheetFilters,
    type FilterChoice,
  } from './filter'
  import FilterMenu from './filter-menu.svelte'
  import { findCells, listGoToNames, resolveGoTo, type FindHit } from './find'
  import FindDialog from './find-dialog.svelte'
  import {
    displayValue,
    editText,
    FORMAT_CHOICES,
    formatCode,
    parseInput,
    type FormatChoiceId,
    type SheetLocale,
  } from './format'
  import FormatToolbar from './format-toolbar.svelte'
  import FormulaAutocomplete from './formula-autocomplete.svelte'
  import {
    acceptAutocomplete,
    activeFunctionCall,
    autocompleteContext,
    canInsertReferenceAt,
    cycleAbsoluteAt,
    formatPickedRef,
    formulaHighlightRuns,
    formulaReferences,
    insertReferenceAt,
  } from './formula-edit'
  import { borderCss, fontFamilyCss, verticalOf } from './grid-style'
  import { toShownFormula, XlsxLossError, type CellWrite, type Loss, type SheetOp } from './ops'
  import PageSetupDialog from './page-setup-dialog.svelte'
  import { frozenOf } from './panes'
  import { pivotCellLook, readSheetPivots } from './pivot'
  import PivotFields, { type PivotLayout } from './pivot-fields.svelte'
  import { pageSetupOf, viewOptionsOf, type PaperSize } from './print'
  import {
    cellKey,
    cellName,
    colName,
    MAX_COLS,
    MAX_ROWS,
    parseCell,
    parseRange,
    rangeName,
    type Range,
  } from './ref'
  import {
    formatRange,
    retext,
    richCells,
    runsText,
    type RichRun,
    type RunFormat,
  } from './rich-text'
  import { outlineOf } from './rows-cols'
  import { selectionOf, selectionStats, type HeldSelection } from './selection'
  import SheetGrid, { type GridCell, type Pos } from './sheet-grid.svelte'
  import { sheetTabColor } from './sheet-tabs'
  import { quoteSheet } from './shift'
  import { guessHeader, type SortKey } from './sort'
  import SortDialog from './sort-dialog.svelte'
  import TableBar from './table-bar.svelte'
  import TableDialog from './table-dialog.svelte'
  import { readSheetTables, tableCellLook, type TableCellLook } from './tables'
  import { pxToWidth, XlsxError } from './workbook'

  /**
   * Excel workbooks in the Drive: the sheet as a grid with its tabs, edited in
   * place — values, formulas (calculated as you type), number formats; add,
   * rename and delete sheets; insert and delete rows and columns; sort,
   * AutoFilter and frozen panes (./sort.ts, ./filter.ts, ./panes.ts); undo/redo.
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
    source,
  }: OfficeViewerProps & {
    saveDelayMs?: number
    idleMs?: number
    /** The workbook's bytes from elsewhere than the file (an .xls/.ods converted for viewing; then canEdit is false). */
    source?: () => Promise<Uint8Array>
  } = $props()

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
  let filterMenu = $state<{
    col: number
    row: number
    at: DOMRect
    choices: FilterChoice[]
  } | null>(null)
  /** Create Table (Ctrl+T) / Create PivotTable: the dialog's starting range. */
  let creating = $state<{ kind: 'table' | 'pivot'; range: string; header: boolean } | null>(null)
  let pivotFieldsOpen = $state(true)
  let sorting = $state<{ range: Range; header: boolean; first: number } | null>(null)
  let extraSelections = $state<Range[]>([])
  let clipState = $state<{
    clip: Clip
    tsv: string
    cut: boolean
    sourceRange: Range
    sourceSheet: string
  } | null>(null)
  let painterClip = $state<Clip | null>(null)
  let findDialog = $state<{ mode: 'find' | 'replace' | 'goto' } | null>(null)
  let findHits = $state<FindHit[]>([])
  let findHitIndex = $state(0)
  let findLastQuery = $state('')
  let pageSetupOpen = $state(false)
  let exportingPdf = $state(false)
  let customFmtOpen = $state(false)
  let customFmtInput = $state('')
  let tabMenuSheet = $state<string | null>(null)
  let draggedTab = $state<string | null>(null)
  let refBoxEditing = $state(false)
  let refBoxText = $state('')
  let refBoxInput = $state<HTMLInputElement | null>(null)
  let formulaInputEl = $state<HTMLInputElement | null>(null)
  let formulaCursor = $state<{ start: number; end: number }>({ start: 0, end: 0 })
  let formulaPointRange = $state<[number, number] | null>(null)
  let acIndex = $state(0)
  let editOrigin = $state<{ sheet: string; pos: Pos } | null>(null)
  let draftRuns = $state<RichRun[] | null>(null)
  let selectedChartId = $state<string | null>(null)
  let chartDialog = $state<
    { mode: 'create'; range: string } | { mode: 'edit'; placement: ChartPlacement } | null
  >(null)
  let chartSheetBox = $state({ width: 760, height: 460 })

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
  const visibleSheets = $derived(sheets.filter((s) => s.state === 'visible'))
  const hiddenSheets = $derived(sheets.filter((s) => s.state === 'hidden'))
  const info = $derived(sheets.find((s) => s.name === sheet) ?? null)
  const data = $derived.by(() => {
    void rev
    return editor && info?.kind === 'worksheet' ? editor.wb.sheet(info.name) : null
  })
  const sheetCharts = $derived.by(() => {
    void rev
    return editor && info ? chartsOn(editor.wb, info) : []
  })
  const chartMax = $derived.by(() => {
    let row = 0
    let col = 0
    for (const c of sheetCharts) {
      if (c.anchor.kind === 'twoCell') {
        row = Math.max(row, c.anchor.to.row)
        col = Math.max(col, c.anchor.to.col)
      } else if (c.anchor.kind === 'oneCell') {
        row = Math.max(row, c.anchor.from.row + 15)
        col = Math.max(col, c.anchor.from.col + 8)
      }
    }
    return { row, col }
  })
  const rows = $derived(
    Math.min(MAX_ROWS, Math.max((data?.maxRow ?? 0) + 31, chartMax.row + 6, 60) + extraRows),
  )
  const cols = $derived(
    Math.min(MAX_COLS, Math.max((data?.maxCol ?? 0) + 6, chartMax.col + 3, 26) + extraCols),
  )
  let held = $state<HeldSelection | null>(null)
  const sel = $derived<Range>(selectionOf(active, anchor, held))
  const allSelections = $derived([...extraSelections, sel])
  const activeRef = $derived(cellName(active))
  const selBoxLabel = $derived(
    sel.top === sel.bottom && sel.left === sel.right ? activeRef : rangeName(sel),
  )
  const history = $derived.by(() => {
    void rev
    return { undo: editor?.canUndo() ?? false, redo: editor?.canRedo() ?? false }
  })

  const viewOpts = $derived.by(() => {
    void rev
    return editor && info?.kind === 'worksheet'
      ? viewOptionsOf(editor.wb, info.name)
      : { showGridlines: true, showHeadings: true, zoomScale: 100 }
  })
  const zoomFactor = $derived(viewOpts.zoomScale / 100)
  const outline = $derived.by(() => {
    void rev
    return editor && info?.kind === 'worksheet' ? outlineOf(editor.wb, info.name) : null
  })
  const tabColors = $derived.by(() => {
    void rev
    const out: Record<string, string | null> = {}
    if (!editor || !ready) return out
    for (const s of sheets) out[s.name] = sheetTabColor(editor.wb, s.name)
    return out
  })

  /** Sort, filter and frozen panes of the sheet on screen (read from its XML). */
  const frozen = $derived.by(() => {
    void rev
    return editor && info?.kind === 'worksheet' ? frozenOf(editor.wb, info.name) : null
  })
  const autoFilter = $derived.by(() => {
    void rev
    return editor && info?.kind === 'worksheet' ? autoFilterOf(editor.wb, info.name) : null
  })
  /** Excel tables and pivot tables of the sheet on screen; the filters there are (the sheet's and its tables'). */
  const tables = $derived.by(() => {
    void rev
    return editor && info?.kind === 'worksheet' ? readSheetTables(editor.wb, info.name) : []
  })
  const pivots = $derived.by(() => {
    void rev
    return editor && info?.kind === 'worksheet' ? readSheetPivots(editor.wb, info.name) : []
  })
  const filters = $derived.by(() => {
    void rev
    return editor && info?.kind === 'worksheet' ? sheetFilters(editor.wb, info.name) : []
  })
  const inRect = (r: Range, p: Pos) =>
    p.row >= r.top && p.row <= r.bottom && p.col >= r.left && p.col <= r.right
  const activeTable = $derived(tables.find((t) => inRect(t.ref, active)) ?? null)
  const activePivot = $derived(pivots.find((p) => inRect(p.location, active)) ?? null)
  const gridFilter = $derived(
    filters.length > 0
      ? {
          ranges: filters.map((f) => f.range),
          filtered: (r: number, c: number) =>
            filters.some((f) => f.range.top === r && f.columns.some((x) => x.col === c)),
        }
      : null,
  )
  const menuFilter = $derived(
    filterMenu ? (filters.find((f) => f.range.top === filterMenu!.row) ?? null) : null,
  )
  const filterStatus = $derived.by(() => {
    if (!autoFilter || autoFilter.columns.length === 0 || !data) return null
    const total = autoFilter.range.bottom - autoFilter.range.top
    let hidden = 0
    for (let r = autoFilter.range.top + 1; r <= autoFilter.range.bottom; r++)
      if (data.rows.get(r)?.hidden) hidden++
    return m.drive_sheet_filter_status({ shown: total - hidden, total })
  })
  const freezeValue = $derived(
    !frozen
      ? 'none'
      : frozen.rows === 1 && frozen.cols === 0
        ? 'row'
        : frozen.rows === 0 && frozen.cols === 1
          ? 'col'
          : 'custom',
  )

  const colWidth = $derived.by(() => {
    void rev
    const d = data
    const z = zoomFactor
    return (c: number) => {
      if (!d) return Math.round(64 * z)
      const col = d.cols.find((x) => c >= x.min && c <= x.max)
      if (col?.hidden) return 0
      return Math.round((col?.widthPx ?? d.defaultColPx) * z)
    }
  })
  const rowHeight = $derived.by(() => {
    void rev
    const d = data
    const z = zoomFactor
    return (r: number) => {
      if (!d) return Math.round(20 * z)
      const row = d.rows.get(r)
      if (row?.hidden) return 0
      return Math.round((row?.heightPx ?? d.defaultRowPx) * z)
    }
  })

  const cellAt = $derived.by(() => {
    void rev
    const d = data
    const ed = editor
    if (!d || !ed) return () => null
    const styles = ed.wb.styles()
    const plain = styles.xf(0)
    const calc = ed.calc()
    const date1904 = ed.wb.date1904
    const richMap = richCells(ed.wb, d.info.name)
    const tbl = tables
    const pvt = pivots
    const lookAt = (r: number, c: number): TableCellLook | null =>
      pivotCellLook(ed.wb, pvt, r, c) ?? tableCellLook(tbl, r, c)
    const edge = (e: { style: string; color?: string | null } | undefined) =>
      e
        ? `${e.style === 'double' ? '3px double' : e.style === 'medium' ? '2px solid' : '1px solid'} ${e.color ?? 'currentColor'}`
        : null
    const bordersAt = (r: number, c: number) => {
      const x = d.cells.get(cellKey(r, c))
      return x ? styles.xf(x.style).border : null
    }
    return (r: number, c: number): GridCell | null => {
      const cell = d.cells.get(cellKey(r, c))
      const near = {
        right: bordersAt(r, c + 1),
        below: bordersAt(r + 1, c),
        firstCol: c === 0,
        firstRow: r === 0,
        filled: false,
      }
      const out = calc.cell(d.info.name, r, c)
      // A table's or pivot table's style draws under the cell's own format.
      const look = lookAt(r, c)
      const lookCss: string[] = []
      if (look) {
        const top = edge(look.borderTop)
        const bottom = edge(look.borderBottom)
        if (top) lookCss.push(`border-top: ${top}`)
        if (bottom) lookCss.push(`border-bottom: ${bottom}`)
      }
      // An empty cell can still show a value: a dynamic array spilled into it.
      if (!cell && out.value === null && !out.kept && !look) {
        // An empty cell still draws the lines its neighbours put on the edges it shares with them.
        const lines = borderCss(null, near)
        return lines.length > 0
          ? {
              text: '',
              align: 'left',
              css: lines.join('; '),
              wrap: false,
              kept: null,
              unreadFormat: false,
            }
          : null
      }
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
      if (st.font.bold || (look?.bold && !st.fill)) css.push('font-weight: 600')
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
      else if (look?.fill) {
        css.push(`background-color: ${look.fill}`)
        if (!color || color.toUpperCase() === '#000000') css.push(`color: ${look.color ?? '#000'}`)
      }
      if (st.font.sizePt && st.font.sizePt !== 11)
        css.push(`font-size: ${Math.round(st.font.sizePt * 1.27)}px`)
      if (st.indent) css.push(`padding-left: ${4 + st.indent * 9}px`)
      const family = fontFamilyCss(st, plain)
      if (family) css.push(family)
      css.push(...borderCss(st.border, { ...near, filled: !!st.fill || !!look?.fill }))
      css.push(...lookCss)
      const runs = cell?.formula ? undefined : richMap.get(cellKey(r, c))
      return {
        text: shown.text,
        align,
        css: css.join('; '),
        wrap: st.wrap,
        vertical: verticalOf(st),
        kept: out.kept ? out.reason : null,
        unreadFormat: !!shown.unreadFormat,
        ...(runs ? { runs } : {}),
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

  /** The active cell's look (the format bar shows it), the workbook's plain font, the active column's and row's size. */
  const activeStyle = $derived.by(() => {
    void rev
    const styles = editor?.wb.styles()
    const cell = data?.cells.get(cellKey(active.row, active.col))
    return styles ? styles.xf(cell?.style ?? 0) : null
  })
  const plainFont = $derived.by(() => {
    void rev
    return editor?.wb.styles().xf(0).font.name ?? null
  })
  const activeWidth = $derived(pxToWidth(colWidth(active.col)))
  const activeHeight = $derived((rowHeight(active.row) * 3) / 4)

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
      accounting: m.drive_sheet_fmt_accounting(),
      date: m.drive_sheet_format_date(),
      date_iso: m.drive_sheet_format_date_iso(),
      time: m.drive_sheet_format_time(),
      datetime: m.drive_sheet_format_datetime(),
      fraction: m.drive_sheet_fmt_fraction(),
      scientific: m.drive_sheet_fmt_scientific(),
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
      case 'macros':
        return m.drive_sheet_note_macros()
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
      case 'merged_values':
        return m.drive_sheet_merge_center()
      case 'not_copied':
        return m.drive_sheet_tab_duplicate()
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
      await open(await (source ? source() : driveApi.readBytes(fileId)))
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
      case 'sort_range':
        return m.drive_sheet_confirm_sort({ range: op.range })
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
    const targetSheet = editOrigin?.sheet ?? sheet
    const targetPos = editOrigin?.pos ?? pos
    const runsToWrite = draftRuns
    editOrigin = null
    draftRuns = null
    formulaPointRange = null
    if (!editor) return
    if (runsToWrite) {
      await change({
        op: 'set_rich_text',
        sheet: targetSheet,
        ref: cellName(targetPos),
        runs: retext(runsToWrite, runsText(runsToWrite), text),
      })
      if (targetSheet !== sheet) sheet = targetSheet
      return
    }
    const targetData =
      editor.wb.findSheet(targetSheet)?.kind === 'worksheet' ? editor.wb.sheet(targetSheet) : null
    const existing = targetData?.cells.get(cellKey(targetPos.row, targetPos.col))
    const prevText =
      existing && targetData
        ? editText(
            existing.value,
            existing.formula === null ? null : toShownFormula(existing.formula),
            formatCode(
              editor.wb.styles().xf(existing.style).numFmtId,
              editor.wb.styles().xf(existing.style).numFmt,
              locale,
            ),
            locale,
            editor.wb.date1904,
          )
        : ''
    if (text === prevText) {
      if (targetSheet !== sheet) sheet = targetSheet
      return
    }
    await change({ op: 'set_cells', sheet: targetSheet, cells: [writeOf(targetPos, text)] })
    if (targetSheet !== sheet) {
      sheet = targetSheet
      active = targetPos
      anchor = targetPos
    }
  }

  async function clearRanges(ranges: Range[], what: ClearWhat = 'contents') {
    if (!data) return
    const ops: SheetOp[] = ranges.map((r) => ({
      op: 'clear_range',
      sheet,
      range: rangeName(r),
      what,
    }))
    if (ops.length === 1) await change(ops[0]!)
    else if (ops.length > 1) await change({ op: 'batch', ops })
  }

  function copyOrCut(range: Range, cut: boolean, event?: ClipboardEvent) {
    if (!editor || !data) return
    const clip = readClip(editor, sheet, range, fileId, locale)
    const tsv = clipToTsv(clip)
    const html = clipToHtml(clip)
    clipState = { clip, tsv, cut, sourceRange: range, sourceSheet: sheet }
    if (event?.clipboardData) {
      event.clipboardData.setData('text/plain', tsv)
      event.clipboardData.setData('text/html', html)
      event.preventDefault()
    } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
        void navigator.clipboard
          .write([
            new ClipboardItem({
              'text/plain': new Blob([tsv], { type: 'text/plain' }),
              'text/html': new Blob([html], { type: 'text/html' }),
            }),
          ])
          .catch(() => navigator.clipboard.writeText(tsv).catch(() => {}))
      } else {
        void navigator.clipboard.writeText(tsv).catch(() => {})
      }
    }
  }

  async function pasteSpecial(
    mode: PasteMode = 'all',
    opts: {
      pos?: Pos
      transpose?: boolean
      skipBlanks?: boolean
      html?: string
      plain?: string
    } = {},
  ) {
    if (!editor) return
    let clip: Clip | null = null
    let isCut = false
    const atPos = opts.pos ?? { row: sel.top, col: sel.left }
    const atRef = opts.pos || (opts.transpose ?? false) ? cellName(atPos) : rangeName(sel)

    const hasExternal = opts.html !== undefined || opts.plain !== undefined
    if (clipState && (!hasExternal || (opts.plain !== undefined && opts.plain === clipState.tsv))) {
      clip = clipState.clip
      isCut = clipState.cut && mode === 'all' && !opts.transpose && !opts.skipBlanks
    } else if (hasExternal) {
      clip = clipFromClipboard({ html: opts.html ?? '', text: opts.plain ?? '' }, locale)
    } else if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
      try {
        const plain = await navigator.clipboard.readText()
        if (clipState && plain === clipState.tsv) {
          clip = clipState.clip
          isCut = clipState.cut && mode === 'all' && !opts.transpose && !opts.skipBlanks
        } else if (plain) {
          clip = clipFromClipboard({ text: plain }, locale)
        }
      } catch {
        if (clipState) {
          clip = clipState.clip
          isCut = clipState.cut && mode === 'all' && !opts.transpose && !opts.skipBlanks
        }
      }
    }
    if (!clip) return
    const ok = await change({
      op: 'paste',
      sheet,
      at: atRef,
      clip,
      paste: mode,
      ...(opts.transpose ? { transpose: true } : {}),
      ...(opts.skipBlanks ? { skipBlanks: true } : {}),
      ...(isCut ? { cut: true } : {}),
    })
    if (ok && isCut) clipState = null
  }

  async function pasteAt(pos: Pos, text: string) {
    await pasteSpecial('all', { pos, plain: text })
  }

  function handlePasteClip(pos: Pos, event: ClipboardEvent) {
    const html = event.clipboardData?.getData('text/html') ?? ''
    const plain = event.clipboardData?.getData('text/plain') ?? ''
    void pasteSpecial('all', { pos, html, plain })
  }

  function copyText(range: Range): string {
    if (!editor) return ''
    return clipToTsv(readClip(editor, sheet, range, fileId, locale))
  }

  async function setFormat(id: string) {
    if (id === '__custom__') {
      customFmtInput = activeStyle?.numFmt ?? 'General'
      customFmtOpen = true
      return
    }
    const choice = FORMAT_CHOICES.find((f) => f.id === id)
    if (!choice) return
    await applyNumberFormat(choice.code)
    grid?.focus()
  }

  async function applyNumberFormat(code: string) {
    const ops: SheetOp[] = allSelections.map((rg) => ({
      op: 'set_format',
      sheet,
      range: rangeName(rg),
      format: code,
    }))
    await change(ops.length === 1 ? ops[0]! : { op: 'batch', ops })
  }

  async function shiftSelDecimals(delta: 1 | -1) {
    if (editing) grid?.finishEdit(true)
    const ops: SheetOp[] = allSelections.map((rg) => ({
      op: 'shift_decimals',
      sheet,
      range: rangeName(rg),
      delta,
    }))
    await change(ops.length === 1 ? ops[0]! : { op: 'batch', ops })
    grid?.focus()
  }

  async function applyMerge(mode: MergeMode) {
    if (editing) grid?.finishEdit(true)
    await change({ op: 'merge_cells', sheet, range: rangeName(sel), mode })
    grid?.focus()
  }

  function togglePainter() {
    if (!editor) return
    if (painterClip) {
      painterClip = null
      return
    }
    painterClip = readClip(editor, sheet, sel, fileId, locale)
  }

  async function onSelectionCommit() {
    if (!painterClip) return
    const clip = painterClip
    painterClip = null
    await change({ op: 'paste', sheet, at: rangeName(sel), clip, paste: 'formats' })
  }

  async function fillRange(source: Range, target: Range) {
    await change({ op: 'fill', sheet, source: rangeName(source), target: rangeName(target) })
  }

  async function fillDoubleClick(source: Range) {
    if (!editor) return
    if (!data) return
    const bottom = fillDownTo(data, source)
    if (bottom === null || bottom <= source.bottom) return
    const target: Range = { ...source, bottom }
    anchor = { row: target.top, col: target.left }
    active = { row: target.bottom, col: target.right }
    await change({ op: 'fill', sheet, source: rangeName(source), target: rangeName(target) })
  }

  async function fillShortcut(dir: 'down' | 'right', range: Range) {
    const opRange = fillShortcutRange(range, dir)
    if (!opRange) return
    await change({
      op: 'fill',
      sheet,
      source: rangeName(opRange.source),
      target: rangeName(opRange.target),
      series: 'copy',
    })
  }

  async function autofitAxis(axis: 'col' | 'row', index: number) {
    if (axis === 'col') {
      const [from, to] =
        wholeCols && index >= sel.left && index <= sel.right
          ? [sel.left, sel.right]
          : [index, index]
      await change({ op: 'autofit_columns', sheet, from, to, locale })
    } else {
      const [from, to] =
        wholeRows && index >= sel.top && index <= sel.bottom
          ? [sel.top, sel.bottom]
          : [index, index]
      await change({ op: 'autofit_rows', sheet, from, to, locale })
    }
  }

  async function runRowColAction(
    action:
      | 'hide_rows'
      | 'unhide_rows'
      | 'hide_cols'
      | 'unhide_cols'
      | 'group_rows'
      | 'ungroup_rows'
      | 'group_cols'
      | 'ungroup_cols'
      | 'autofit_col'
      | 'autofit_row',
  ) {
    switch (action) {
      case 'hide_rows':
        await change({ op: 'hide_rows', sheet, from: sel.top, to: sel.bottom, hidden: true })
        break
      case 'unhide_rows':
        await change({ op: 'hide_rows', sheet, from: sel.top, to: sel.bottom, hidden: false })
        break
      case 'hide_cols':
        await change({ op: 'hide_columns', sheet, from: sel.left, to: sel.right, hidden: true })
        break
      case 'unhide_cols':
        await change({ op: 'hide_columns', sheet, from: sel.left, to: sel.right, hidden: false })
        break
      case 'group_rows':
        await change({ op: 'group_rows', sheet, from: sel.top, to: sel.bottom })
        break
      case 'ungroup_rows':
        await change({ op: 'ungroup_rows', sheet, from: sel.top, to: sel.bottom })
        break
      case 'group_cols':
        await change({ op: 'group_columns', sheet, from: sel.left, to: sel.right })
        break
      case 'ungroup_cols':
        await change({ op: 'ungroup_columns', sheet, from: sel.left, to: sel.right })
        break
      case 'autofit_col':
        await change({ op: 'autofit_columns', sheet, from: sel.left, to: sel.right, locale })
        break
      case 'autofit_row':
        await change({ op: 'autofit_rows', sheet, from: sel.top, to: sel.bottom, locale })
        break
    }
    grid?.focus()
  }

  async function runOutlineAction(act: {
    axis: 'row' | 'col'
    kind: 'toggle' | 'level'
    from?: number
    to?: number
    collapsed?: boolean
    level?: number
  }) {
    if (act.kind === 'level' && act.level !== undefined) {
      await change({ op: 'set_outline_level', sheet, axis: act.axis, level: act.level })
      return
    }
    if (
      act.kind === 'toggle' &&
      act.from !== undefined &&
      act.to !== undefined &&
      act.collapsed !== undefined
    ) {
      await change({
        op: act.axis === 'row' ? 'collapse_rows' : 'collapse_columns',
        sheet,
        from: act.from,
        to: act.to,
        collapsed: act.collapsed,
      })
    }
  }

  function runFindSearch(opts: {
    query: string
    scope: 'sheet' | 'workbook'
    lookIn: 'formulas' | 'values'
    matchCase: boolean
    wholeCell: boolean
  }) {
    if (!editor) return
    findLastQuery = opts.query
    findHits = findCells(
      editor,
      {
        query: opts.query,
        sheet: opts.scope === 'sheet' ? sheet : null,
        lookIn: opts.lookIn,
        matchCase: opts.matchCase,
        wholeCell: opts.wholeCell,
      },
      locale,
    )
    findHitIndex = 0
    if (findHits.length > 0) void jumpToHit(findHits[0]!)
  }

  async function jumpToHit(hit: FindHit) {
    if (!editor) return
    if (hit.sheet !== sheet) sheet = hit.sheet
    const r = parseRange(hit.ref)
    if (r) {
      extraSelections = []
      anchor = { row: r.top, col: r.left }
      active = { row: r.top, col: r.left }
      await tick()
      grid?.revealActive()
    }
  }

  function navigateFindHit(delta: 1 | -1) {
    if (findHits.length === 0) return
    findHitIndex = (findHitIndex + delta + findHits.length) % findHits.length
    void jumpToHit(findHits[findHitIndex]!)
  }

  async function runReplaceOne(opts: {
    find: string
    replace: string
    scope: 'sheet' | 'workbook'
    matchCase: boolean
    wholeCell: boolean
  }) {
    if (!editor) return
    if (findHits.length === 0 || findLastQuery !== opts.find) {
      runFindSearch({ ...opts, query: opts.find, lookIn: 'formulas' })
      if (findHits.length === 0) return
    }
    const target = findHits[findHitIndex]
    if (!target) return
    await change({
      op: 'replace',
      find: opts.find,
      replace: opts.replace,
      sheet: opts.scope === 'sheet' ? sheet : null,
      matchCase: opts.matchCase,
      wholeCell: opts.wholeCell,
      cells: [{ sheet: target.sheet, ref: target.ref }],
    })
    runFindSearch({ ...opts, query: opts.find, lookIn: 'formulas' })
  }

  async function runReplaceAll(opts: {
    find: string
    replace: string
    scope: 'sheet' | 'workbook'
    matchCase: boolean
    wholeCell: boolean
  }) {
    await change({
      op: 'replace',
      find: opts.find,
      replace: opts.replace,
      sheet: opts.scope === 'sheet' ? sheet : null,
      matchCase: opts.matchCase,
      wholeCell: opts.wholeCell,
    })
    runFindSearch({ ...opts, query: opts.find, lookIn: 'formulas' })
  }

  function goToTarget(raw: string): string | null {
    if (!editor) return null
    try {
      const target = resolveGoTo(editor.wb, sheet, raw)
      if (target.sheet !== sheet) sheet = target.sheet
      extraSelections = []
      anchor = { row: target.range.top, col: target.range.left }
      active = { row: target.range.top, col: target.range.left }
      if (target.range.bottom !== target.range.top || target.range.right !== target.range.left) {
        active = { row: target.range.bottom, col: target.range.right }
        // Keep top-left as active cell and bottom-right as anchor so name box focuses A1 of range
        anchor = { row: target.range.bottom, col: target.range.right }
        active = { row: target.range.top, col: target.range.left }
      }
      void tick().then(() => {
        grid?.revealActive()
        grid?.focus()
      })
      return null
    } catch (err) {
      return err instanceof Error ? err.message : m.drive_sheet_confirm_change()
    }
  }

  async function exportPdf(opts: { scope: 'active' | 'all' }) {
    if (!editor) return
    exportingPdf = true
    failure = null
    try {
      if (autosave.unsaved() !== null || save.status === 'saving') {
        await autosave.flush()
      }
      const res = await driveApi.exportSheetPdf(fileId, {
        ...(opts.scope === 'active' ? { sheet } : {}),
        locale,
      })
      const url = URL.createObjectURL(
        new Blob([res.bytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' }),
      )
      const a = document.createElement('a')
      a.href = url
      a.download = res.filename
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      pageSetupOpen = false
    } catch (err) {
      failure = driveShownError(err)
    } finally {
      exportingPdf = false
    }
  }

  // ---------------------------------------------------------------------------
  // Cell format and sizes (./format-cells.ts; the same operations as drive.sheet_format)

  function patchToRunFormat(patch: StylePatch): RunFormat {
    const rf: RunFormat = {}
    if (patch.bold !== undefined) rf.bold = patch.bold
    if (patch.italic !== undefined) rf.italic = patch.italic
    if (patch.underline !== undefined) rf.underline = patch.underline
    if (patch.strike !== undefined) rf.strike = patch.strike
    if (patch.fontColor !== undefined && patch.fontColor !== null) rf.color = patch.fontColor
    if (patch.fontSize !== undefined) rf.size = patch.fontSize
    if (patch.fontName !== undefined) rf.font = patch.fontName
    return rf
  }

  async function applyStyle(patch: StylePatch) {
    if (
      editing &&
      !draft.startsWith('=') &&
      formulaCursor.end > formulaCursor.start &&
      formulaInputEl
    ) {
      const curRuns = draftRuns ??
        (editor ? richCells(editor.wb, sheet).get(cellKey(active.row, active.col)) : undefined) ?? [
          { text: draft },
        ]
      const nextRuns = formatRange(
        retext(curRuns, runsText(curRuns), draft),
        formulaCursor.start,
        formulaCursor.end,
        patchToRunFormat(patch),
      )
      draftRuns = nextRuns
      const [s, e] = [formulaCursor.start, formulaCursor.end]
      void tick().then(() => {
        formulaInputEl?.focus()
        formulaInputEl?.setSelectionRange(s, e)
      })
      return
    }
    if (editing) grid?.finishEdit(true)
    const ops: SheetOp[] = allSelections.map((rg) => ({
      op: 'set_style',
      sheet,
      range: rangeName(rg),
      style: patch,
    }))
    await change(ops.length === 1 ? ops[0]! : { op: 'batch', ops })
    grid?.focus()
  }

  /** Whole columns (or rows) selected through their headers: a size goes to all of them. */
  const wholeCols = $derived(sel.top === 0 && sel.bottom === rows - 1)
  const wholeRows = $derived(sel.left === 0 && sel.right === cols - 1)

  /** The format bar sizes the selected columns; a dragged edge its own column, or all selected whole columns. */
  async function setColumnWidth(chars: number | null, dragged?: number) {
    const all = dragged === undefined || (wholeCols && dragged >= sel.left && dragged <= sel.right)
    const [from, to] = all ? [sel.left, sel.right] : [dragged, dragged]
    await change({ op: 'set_column_width', sheet, from, to, width: chars })
  }

  async function setRowHeight(points: number | null, dragged?: number) {
    const all = dragged === undefined || (wholeRows && dragged >= sel.top && dragged <= sel.bottom)
    const [from, to] = all ? [sel.top, sel.bottom] : [dragged, dragged]
    await change({ op: 'set_row_height', sheet, from, to, height: points })
  }

  /** A dragged edge: pixels (divided by zoom) → Excel characters (columns) or points (rows, in quarter points). */
  function onResize(axis: 'col' | 'row', index: number, px: number) {
    const unzoomed = px / (zoomFactor || 1)
    if (axis === 'col') void setColumnWidth(pxToWidth(unzoomed), index)
    else void setRowHeight(Math.round(unzoomed * 3) / 4, index)
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

  // ---------------------------------------------------------------------------
  // Sort, filter, freeze panes

  const within = (r: Range, p: Pos) =>
    p.row >= r.top && p.row <= r.bottom && p.col >= r.left && p.col <= r.right

  /** What a sort works on, as Excel picks it: the filter range (it has a header), a selected range, or the block of cells around the active cell (header guessed). */
  function sortTarget(): { range: Range; header: boolean } | null {
    if (!data || !editor) return null
    if (autoFilter && within(autoFilter.range, active))
      return { range: autoFilter.range, header: true }
    if (activeTable) return { range: activeTable.ref, header: activeTable.headerRowCount > 0 }
    if (sel.top === sel.bottom && sel.left === sel.right) {
      const range = currentRegion(data, active)
      return { range, header: guessHeader(editor, sheet, range) }
    }
    const range = {
      ...sel,
      bottom: Math.min(sel.bottom, Math.max(sel.top, data.maxRow)),
      right: Math.min(sel.right, Math.max(sel.left, data.maxCol)),
    }
    return { range, header: false }
  }

  async function sortBy(keys: SortKey[], target: { range: Range; header: boolean }) {
    await change({
      op: 'sort_range',
      sheet,
      range: rangeName(target.range),
      header: target.header,
      keys,
    })
    grid?.focus()
  }

  async function quickSort(descending: boolean) {
    const t = sortTarget()
    if (t) await sortBy([{ col: active.col, descending }], t)
  }

  function openSort() {
    const t = sortTarget()
    if (t) sorting = { ...t, first: active.col }
  }

  function headerText(col: number): string {
    return sorting ? (cellAt(sorting.range.top, col)?.text ?? '') : ''
  }

  async function toggleFilter() {
    filterMenu = null
    if (activeTable && activeTable.headerRowCount > 0)
      await updateTable({ autoFilter: activeTable.autoFilter === null })
    else if (autoFilter) await change({ op: 'set_autofilter', sheet, range: null })
    else await change({ op: 'set_autofilter', sheet, range: rangeName(sel) })
    grid?.focus()
  }

  function openFilterMenu(col: number, at: DOMRect, row: number) {
    if (!editor) return
    const f = filters.find((x) => x.range.top === row)
    try {
      filterMenu = { col, row, at, choices: columnChoices(editor, sheet, col, locale, f?.table) }
    } catch (err) {
      failure = shown(err)
    }
  }

  async function applyFilter(col: number, values: string[] | null, blanks: boolean) {
    const table = menuFilter?.table
    filterMenu = null
    await change({
      op: 'filter_column',
      sheet,
      col,
      values,
      blanks,
      ...(table ? { table } : {}),
    })
    grid?.focus()
  }

  async function sortFromFilter(col: number, descending: boolean) {
    const f = menuFilter
    filterMenu = null
    if (!f) return
    const t = f.table ? tables.find((x) => x.displayName === f.table) : null
    await sortBy([{ col, descending }], { range: t ? t.ref : f.range, header: true })
  }

  async function freeze(choice: string) {
    const [rows, cols] =
      choice === 'row'
        ? [1, 0]
        : choice === 'col'
          ? [0, 1]
          : choice === 'at'
            ? [active.row, active.col]
            : [0, 0]
    await change({ op: 'freeze_panes', sheet, rows, cols })
    grid?.focus()
  }

  // ---------------------------------------------------------------------------
  // Tables and pivot tables (./tables.ts, ./pivot.ts; = drive.sheet_table_*, drive.sheet_pivot_*)

  /** Ctrl+T / PivotTable: the selection, or the block of cells around the active cell (a PivotTable in a table: the table). */
  function openCreate(kind: 'table' | 'pivot') {
    if (!data || !editor) return
    if (kind === 'table' && activeTable) return
    if (kind === 'pivot' && activeTable) {
      creating = { kind, range: activeTable.displayName, header: true }
      return
    }
    const single = sel.top === sel.bottom && sel.left === sel.right
    const range = single ? currentRegion(data, active) : sel
    const text = rangeName(range)
    creating = {
      kind,
      range: kind === 'pivot' ? `${quoteSheet(sheet)}!${text}` : text,
      header: kind === 'table' ? true : guessHeader(editor, sheet, range),
    }
  }

  async function created(out: { range: string; header: boolean; at: string | null }) {
    const c = creating
    creating = null
    if (!c) return
    if (c.kind === 'table') {
      await change({ op: 'create_table', sheet, range: out.range, hasHeaders: out.header })
      grid?.focus()
      return
    }
    const at = out.at !== null ? parseCell(out.at) : null
    if (out.at !== null && !at) {
      failure = { error: m.drive_sheet_pivot_bad_cell({ ref: out.at }), agent: null }
      return
    }
    const ok = await change({
      op: 'create_pivot',
      source: out.range,
      ...(at ? { targetSheet: sheet, targetCell: out.at! } : {}),
    })
    if (!ok) return
    const pos = at ?? { row: 2, col: 0 }
    active = pos
    anchor = pos
    pivotFieldsOpen = true
  }

  async function updateTable(patch: Record<string, unknown>) {
    const t = activeTable
    if (!t) return
    await change({ op: 'update_table', sheet, table: t.displayName, ...patch })
  }

  async function convertTable() {
    const t = activeTable
    if (t)
      await change({ op: 'delete_table', sheet, table: t.displayName, mode: 'convert_to_range' })
  }

  async function layoutPivot(l: PivotLayout) {
    const p = activePivot
    if (!p) return
    await change({
      op: 'update_pivot',
      sheet,
      pivot: p.name,
      rowFields: l.rows,
      colFields: l.columns,
      pageFields: l.filters,
      dataFields: l.values,
    })
  }

  async function refreshPivot() {
    const p = activePivot
    if (p) await change({ op: 'refresh_pivot', sheet, pivot: p.name })
  }

  async function deletePivot() {
    const p = activePivot
    if (p) await change({ op: 'delete_pivot', sheet, pivot: p.name })
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
    selectedChartId = null
    rev++
    autosave.change(String(editor.version()))
    touchIdle()
  }

  // ---------------------------------------------------------------------------
  // Charts (./chart-ops.ts, ./chart-overlay.svelte, ./chart-dialog.svelte)

  function openInsertChart() {
    if (!editable || !data) return
    if (editing) grid?.finishEdit(true)
    const single = sel.top === sel.bottom && sel.left === sel.right
    const range = single ? rangeName(currentRegion(data, active)) : rangeName(sel)
    chartDialog = { mode: 'create', range }
  }

  async function applyChartOp(op: SheetOp): Promise<string | null> {
    if (await change(op)) return null
    const msg = failure?.error ?? null
    failure = null
    return msg
  }

  function moveChart(chartId: string, to: ChartPosition) {
    void change({ op: 'chart_move', sheet, chart: chartId, to })
  }

  function deleteChart(chartId: string) {
    if (selectedChartId === chartId) selectedChartId = null
    void change({ op: 'chart_delete', sheet, chart: chartId })
  }

  function observeChartSheet(node: HTMLElement) {
    let raf = 0
    const measure = () => {
      const nextW = Math.max(240, node.clientWidth || 760)
      const nextH = Math.max(200, node.clientHeight || 460)
      if (
        Math.abs(nextW - chartSheetBox.width) > 2 ||
        Math.abs(nextH - chartSheetBox.height) > 2
      ) {
        chartSheetBox = { width: nextW, height: nextH }
      }
    }
    const schedule = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = 0
        measure()
      })
    }
    measure()
    const ro = new ResizeObserver(schedule)
    ro.observe(node)
    return {
      destroy: () => {
        if (raf) cancelAnimationFrame(raf)
        ro.disconnect()
      },
    }
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
    if (event.key === 'F5' && !mod && !event.altKey) {
      event.preventDefault()
      findDialog = { mode: 'goto' }
      return
    }
    if (!mod) return
    const key = event.key.toLowerCase()
    if (key === 'f' && !event.shiftKey && !event.altKey) {
      event.preventDefault()
      findDialog = { mode: 'find' }
      return
    }
    if (key === 'g' && !event.shiftKey && !event.altKey) {
      event.preventDefault()
      findDialog = { mode: 'goto' }
      return
    }
    if (!editable) return
    if (key === 'h' && !event.shiftKey && !event.altKey) {
      event.preventDefault()
      findDialog = { mode: 'replace' }
      return
    }
    const toggle = { b: 'bold', i: 'italic', u: 'underline' } as const
    if ((key === 'b' || key === 'i' || key === 'u') && !event.shiftKey && !event.altKey) {
      event.preventDefault()
      const prop = toggle[key]
      if (activeStyle) void applyStyle({ [prop]: !activeStyle.font[prop] })
    } else if (key === 'z') {
      event.preventDefault()
      void (event.shiftKey ? redo() : undo())
    } else if (key === 'y') {
      event.preventDefault()
      void redo()
    } else if ((key === 't' || key === 'l') && !event.shiftKey && !event.altKey) {
      // Excel: Ctrl+T (and Ctrl+L) create a table.
      event.preventDefault()
      if (editing) grid?.finishEdit(true)
      openCreate('table')
    }
  }

  // ---------------------------------------------------------------------------
  // Formula bar, autocomplete, hints, coloured refs & point-to-select

  const formulaTextNow = $derived(editing ? draft : barText)
  const formulaHighlightSegs = $derived(
    editing && draft.startsWith('=') ? formulaHighlightRuns(draft) : null,
  )
  const gridFormulaRefs = $derived.by(() => {
    if (!editing || !draft.startsWith('=')) return []
    const homeSheet = editOrigin?.sheet ?? sheet
    return formulaReferences(draft).filter(
      (r) =>
        !r.sheet ||
        r.sheet.toLowerCase() === sheet.toLowerCase() ||
        (r.sheet === null && homeSheet.toLowerCase() === sheet.toLowerCase()),
    )
  })
  const acCtx = $derived(
    editing && draft.startsWith('=') ? autocompleteContext(draft, formulaCursor.end) : null,
  )
  const acMatches = $derived(acCtx?.matches ?? [])
  const safeAcIndex = $derived(acMatches.length === 0 ? 0 : Math.min(acIndex, acMatches.length - 1))
  const fnHint = $derived(
    editing && draft.startsWith('=') ? activeFunctionCall(draft, formulaCursor.end) : null,
  )
  const pointSelectActive = $derived(
    editing &&
      draft.startsWith('=') &&
      canInsertReferenceAt(draft, formulaCursor.start, formulaCursor.end, formulaPointRange),
  )

  function syncFormulaCursor() {
    if (!formulaInputEl) return
    formulaCursor = {
      start: formulaInputEl.selectionStart ?? draft.length,
      end: formulaInputEl.selectionEnd ?? draft.length,
    }
  }

  function pickAutocompleteFn(name: string) {
    if (!acCtx) return
    const next = acceptAutocomplete(draft, acCtx, name)
    draft = next.text
    acIndex = 0
    formulaPointRange = null
    formulaCursor = { start: next.cursor, end: next.cursor }
    void tick().then(() => {
      formulaInputEl?.focus()
      formulaInputEl?.setSelectionRange(next.cursor, next.cursor)
    })
  }

  function handlePointSelect(range: Range, commit: boolean) {
    if (!editing || !draft.startsWith('=')) return
    const homeSheet = editOrigin?.sheet ?? sheet
    const refText =
      range.top === range.bottom && range.left === range.right
        ? cellName({ row: range.top, col: range.left })
        : rangeName(range)
    const picked = formatPickedRef(refText, sheet, homeSheet)
    const inserted = insertReferenceAt(
      draft,
      formulaCursor.start,
      formulaCursor.end,
      picked,
      formulaPointRange,
    )
    draft = inserted.text
    formulaPointRange = [inserted.refStart, inserted.refEnd]
    formulaCursor = { start: inserted.refEnd, end: inserted.refEnd }
    void tick().then(() => {
      if (formulaInputEl) {
        formulaInputEl.setSelectionRange(inserted.refEnd, inserted.refEnd)
      }
      if (commit && !formulaInputEl) {
        const el = document.querySelector<HTMLTextAreaElement>('[data-testid="xlsx-cell-editor"]')
        el?.setSelectionRange(inserted.refEnd, inserted.refEnd)
      }
    })
  }

  function onFormulaFocus() {
    if (!editable) return
    if (!editing) {
      draft = barText
      draftRuns = editor
        ? (richCells(editor.wb, sheet).get(cellKey(active.row, active.col)) ?? null)
        : null
      editOrigin = { sheet, pos: { ...active } }
      editing = true
    } else if (!editOrigin) {
      editOrigin = { sheet, pos: { ...active } }
    }
    void tick().then(syncFormulaCursor)
  }

  function onFormulaInput(event: Event & { currentTarget: HTMLInputElement }) {
    draft = event.currentTarget.value
    formulaPointRange = null
    acIndex = 0
    formulaCursor = {
      start: event.currentTarget.selectionStart ?? draft.length,
      end: event.currentTarget.selectionEnd ?? draft.length,
    }
  }

  function onFormulaKeydown(event: KeyboardEvent) {
    if (acMatches.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        acIndex = (safeAcIndex + 1) % acMatches.length
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        acIndex = (safeAcIndex - 1 + acMatches.length) % acMatches.length
        return
      }
      if (event.key === 'Tab') {
        event.preventDefault()
        pickAutocompleteFn(acMatches[safeAcIndex]!.name)
        return
      }
    }
    if (event.key === 'F4' && draft.startsWith('=')) {
      event.preventDefault()
      const start = formulaInputEl?.selectionStart ?? formulaCursor.start
      const end = formulaInputEl?.selectionEnd ?? formulaCursor.end
      const cycled = cycleAbsoluteAt(draft, start, end)
      if (cycled) {
        draft = cycled.text
        formulaPointRange = null
        // As Excel: the caret stays after the reference (typing goes on after it).
        formulaCursor = { start: cycled.selEnd, end: cycled.selEnd }
        void tick().then(() => formulaInputEl?.setSelectionRange(cycled.selEnd, cycled.selEnd))
      }
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      grid?.finishEdit(true, event.shiftKey ? 'up' : 'down')
    } else if (event.key === 'Escape') {
      event.preventDefault()
      editOrigin = null
      draftRuns = null
      formulaPointRange = null
      grid?.finishEdit(false)
    } else if (event.key === 'Tab') {
      event.preventDefault()
      grid?.finishEdit(true, event.shiftKey ? 'left' : 'right')
    }
  }

  const selStats = $derived.by(() => {
    void rev
    if (!editor || !info || info.kind !== 'worksheet' || !ready) return null
    return selectionStats(editor, info.name, allSelections)
  })
  const fmtStatNum = (n: number) =>
    Number.isInteger(n)
      ? n.toLocaleString(locale === 'de' ? 'de-DE' : 'en-US')
      : n.toLocaleString(locale === 'de' ? 'de-DE' : 'en-US', { maximumFractionDigits: 4 })

  // ---------------------------------------------------------------------------
  // Sheet tabs

  async function pickSheet(n: string) {
    const keepFormulaPoint = editing && draft.startsWith('=')
    if (keepFormulaPoint) {
      if (!editOrigin) editOrigin = { sheet, pos: { ...active } }
      sheet = n
      tabMenuSheet = null
      extraRows = 0
      extraCols = 0
      return
    }
    if (editing) grid?.finishEdit(true)
    sheet = n
    tabMenuSheet = null
    extraSelections = []
    selectedChartId = null
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
        <button
          type="button"
          class={btn}
          onclick={() => copyOrCut(sel, false)}
          title={m.drive_sheet_copy()}
          aria-label={m.drive_sheet_copy()}
          data-testid="xlsx-copy-btn"><CopyIcon class="size-4" aria-hidden="true" /></button
        >
        <button
          type="button"
          class={btn}
          onclick={() => copyOrCut(sel, true)}
          title={m.drive_sheet_cut()}
          aria-label={m.drive_sheet_cut()}
          data-testid="xlsx-cut-btn"><ScissorsIcon class="size-4" aria-hidden="true" /></button
        >
        <button
          type="button"
          class={btn}
          onclick={() => void pasteSpecial('all')}
          title={m.drive_sheet_paste()}
          aria-label={m.drive_sheet_paste()}
          data-testid="xlsx-paste-btn">{m.drive_sheet_paste()}</button
        >
        <select
          class="h-8 w-32 rounded-md border border-input bg-background px-2 text-xs text-foreground"
          value=""
          aria-label={m.drive_sheet_paste_special()}
          onchange={(e) => {
            const v = e.currentTarget.value
            e.currentTarget.value = ''
            if (v === 'values' || v === 'formulas' || v === 'formats') void pasteSpecial(v)
            else if (v === 'transpose') void pasteSpecial('all', { transpose: true })
            else if (v === 'skip_blanks') void pasteSpecial('all', { skipBlanks: true })
          }}
          data-testid="xlsx-paste-special"
        >
          <option value="" disabled>{m.drive_sheet_paste_special()}</option>
          <option value="values">{m.drive_sheet_paste_values()}</option>
          <option value="formulas">{m.drive_sheet_paste_formulas()}</option>
          <option value="formats">{m.drive_sheet_paste_formats()}</option>
          <option value="transpose">{m.drive_sheet_paste_transpose()}</option>
          <option value="skip_blanks">{m.drive_sheet_paste_skip_blanks()}</option>
        </select>
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
            <option value="__custom__">{m.drive_sheet_fmt_custom()}</option>
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
        <span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
        <button
          type="button"
          class={btn}
          onclick={() => void quickSort(false)}
          title={m.drive_sheet_sort_asc()}
          aria-label={m.drive_sheet_sort_asc()}
          data-testid="xlsx-sort-asc"><ArrowDownAZIcon class="size-4" aria-hidden="true" /></button
        >
        <button
          type="button"
          class={btn}
          onclick={() => void quickSort(true)}
          title={m.drive_sheet_sort_desc()}
          aria-label={m.drive_sheet_sort_desc()}
          data-testid="xlsx-sort-desc"><ArrowDownZAIcon class="size-4" aria-hidden="true" /></button
        >
        <button type="button" class={btn} onclick={openSort} data-testid="xlsx-sort-open"
          >{m.drive_sheet_sort_custom()}</button
        >
        <button
          type="button"
          class="{btn} {autoFilter ? 'bg-muted text-foreground' : ''}"
          aria-pressed={!!autoFilter}
          onclick={() => void toggleFilter()}
          title={autoFilter ? m.drive_sheet_filter_off_hint() : m.drive_sheet_filter_hint()}
          data-testid="xlsx-filter-toggle"
          ><FunnelIcon class="size-4" aria-hidden="true" />{m.drive_sheet_filter()}</button
        >
        <button
          type="button"
          class={btn}
          onclick={() => openCreate('table')}
          disabled={!!activeTable}
          title={m.drive_sheet_table_hint()}
          aria-keyshortcuts="Control+T"
          data-testid="xlsx-table-create-open"
          ><TableIcon class="size-4" aria-hidden="true" />{m.drive_sheet_table()}</button
        >
        <button
          type="button"
          class={btn}
          onclick={() => openCreate('pivot')}
          title={m.drive_sheet_pivot_hint()}
          data-testid="xlsx-pivot-create-open"
          ><SheetIcon class="size-4" aria-hidden="true" />{m.drive_sheet_pivot()}</button
        >
        <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span class="sr-only sm:not-sr-only">{m.drive_sheet_freeze()}</span>
          <select
            class="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            value={freezeValue}
            onchange={(e) => void freeze(e.currentTarget.value)}
            data-testid="xlsx-freeze"
          >
            <option value="none">{m.drive_sheet_freeze_none()}</option>
            <option value="row">{m.drive_sheet_freeze_top_row()}</option>
            <option value="col">{m.drive_sheet_freeze_first_col()}</option>
            {#if freezeValue === 'custom' && frozen}<option value="custom" disabled
                >{m.drive_sheet_freeze_current({ rows: frozen.rows, cols: frozen.cols })}</option
              >{/if}
            <option value="at">{m.drive_sheet_freeze_at({ ref: activeRef })}</option>
          </select>
        </label>
        <button
          type="button"
          class={btn}
          onclick={() => (findDialog = { mode: 'find' })}
          title={m.drive_sheet_find_replace()}
          aria-label={m.drive_sheet_find_replace()}
          data-testid="xlsx-find-btn"><SearchIcon class="size-4" aria-hidden="true" /></button
        >
        <button
          type="button"
          class={btn}
          onclick={() => (pageSetupOpen = true)}
          data-testid="xlsx-page-setup-btn">{m.drive_sheet_page_setup()}</button
        >
        <span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
        <button
          type="button"
          class={btn}
          disabled={info?.kind !== 'worksheet'}
          onclick={openInsertChart}
          title={m.drive_sheet_chart_insert()}
          data-testid="xlsx-insert-chart"
          ><ChartColumnIcon class="size-4" aria-hidden="true" />{m.drive_sheet_chart_insert()}</button
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
      {#if activeStyle && data}
        <FormatToolbar
          style={activeStyle}
          {plainFont}
          width={activeWidth}
          height={activeHeight}
          painterActive={!!painterClip}
          onstyle={(patch) => void applyStyle(patch)}
          onwidth={(chars) => void setColumnWidth(chars)}
          onheight={(points) => void setRowHeight(points)}
          onmerge={(mode) => void applyMerge(mode)}
          onclear={(what) => void clearRanges(allSelections, what)}
          onpainter={togglePainter}
          onshiftdecimals={(delta) => void shiftSelDecimals(delta)}
          onrowcolaction={(act) => void runRowColAction(act)}
        />
      {/if}
    {:else if ready}
      <div class="flex flex-wrap items-center gap-1 border-b px-2 py-1" role="toolbar">
        <button
          type="button"
          class={btn}
          onclick={() => (findDialog = { mode: 'find' })}
          data-testid="xlsx-find-btn"
          ><SearchIcon class="size-4" aria-hidden="true" />{m.drive_sheet_find_tab()}</button
        >
        <button
          type="button"
          class={btn}
          onclick={() => (pageSetupOpen = true)}
          data-testid="xlsx-page-setup-btn">{m.drive_sheet_export_pdf()}</button
        >
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

    {#if activeTable}
      <TableBar
        table={activeTable}
        {editable}
        onupdate={(patch) => void updateTable(patch)}
        onconvert={() => void convertTable()}
      />
    {/if}

    <!-- Formula bar & Name Box -->
    <div class="relative flex items-center gap-2 border-b px-2 py-1">
      <input
        bind:this={refBoxInput}
        type="text"
        value={refBoxEditing ? refBoxText : selBoxLabel}
        class="h-7 w-20 shrink-0 rounded border border-border bg-background px-1.5 text-center font-mono text-xs tabular-nums focus:ring-1 focus:ring-ring focus:outline-none"
        aria-label={m.drive_sheet_ref_box()}
        onfocus={() => {
          refBoxEditing = true
          refBoxText = selBoxLabel
          void tick().then(() => refBoxInput?.select())
        }}
        oninput={(e) => (refBoxText = e.currentTarget.value)}
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            refBoxEditing = false
            const err = goToTarget(refBoxText)
            if (err) notice = err
          } else if (e.key === 'Escape') {
            e.preventDefault()
            refBoxEditing = false
            grid?.focus()
          }
        }}
        onblur={() => (refBoxEditing = false)}
        data-testid="xlsx-ref"
      />
      <span class="font-serif text-sm text-muted-foreground italic" aria-hidden="true">fx</span>
      <div class="relative min-w-0 flex-1">
        {#if formulaHighlightSegs}
          <div
            class="pointer-events-none absolute inset-0 overflow-hidden px-2 font-mono text-sm leading-7 whitespace-pre"
            aria-hidden="true"
            data-testid="xlsx-formula-highlight"
          >
            {#each formulaHighlightSegs as seg, idx (idx)}<span
                style={seg.color ? `color: ${seg.color}; font-weight: 600;` : undefined}
                >{seg.text}</span
              >{/each}
          </div>
        {/if}
        <input
          bind:this={formulaInputEl}
          data-xlsx-formula-bar="true"
          value={formulaTextNow}
          readonly={!editable}
          class="h-7 w-full rounded border border-input {formulaHighlightSegs
            ? 'bg-transparent text-transparent caret-foreground'
            : 'bg-background'} px-2 font-mono text-sm"
          aria-label={m.drive_sheet_formula_bar({ ref: activeRef })}
          spellcheck="false"
          onfocus={onFormulaFocus}
          oninput={onFormulaInput}
          onclick={syncFormulaCursor}
          onkeyup={syncFormulaCursor}
          onselect={syncFormulaCursor}
          onkeydown={onFormulaKeydown}
          data-testid="xlsx-formula"
        />
        {#if editing && draft.startsWith('=')}
          <FormulaAutocomplete
            matches={acMatches}
            selectedIndex={safeAcIndex}
            hint={fnHint}
            onpick={pickAutocompleteFn}
          />
        {/if}
      </div>
    </div>

    {#if info && info.kind !== 'worksheet'}
      {#if info.kind === 'chartsheet' && sheetCharts[0] && editor}
        {@const chart = sheetCharts[0]}
        <div class="flex min-h-0 flex-1 flex-col" data-testid="xlsx-chart-sheet">
          {#if editable}
            <div class="flex items-center gap-2 border-b bg-muted/20 px-3 py-1.5 text-sm">
              <span class="font-medium text-foreground">{chart.name}</span>
              <Button
                size="sm"
                variant="outline"
                class="ml-auto"
                onclick={() => (chartDialog = { mode: 'edit', placement: chart })}
                data-testid="xlsx-chart-sheet-edit">{m.drive_sheet_chart_edit()}</Button
              >
            </div>
          {/if}
          <div class="chart-sheet-host min-h-[24rem] flex-1 overflow-hidden p-4" use:observeChartSheet>
            <ChartView
              wb={editor.wb}
              calc={() => editor!.calc()}
              placement={chart}
              width={chartSheetBox.width - 32}
              height={chartSheetBox.height - 32}
              {locale}
              {rev}
            />
          </div>
        </div>
      {:else}
        <div
          class="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-sm text-muted-foreground"
          data-testid="xlsx-chart-sheet"
        >
          <ChartColumnIcon class="size-8" aria-hidden="true" />
          <p>{m.drive_sheet_chart_sheet({ name: info.name })}</p>
        </div>
      {/if}
    {:else if data}
      <div class="flex min-h-0 min-w-0 flex-1">
      <SheetGrid
        bind:this={grid}
        bind:active
        bind:anchor
        bind:extraSelections
        bind:held
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
        {data}
        label={m.drive_sheet_grid_label({ sheet: info?.name ?? '' })}
        editTextOf={contentText}
        oncommit={(pos, text) => void commitCell(pos, text)}
        onclear={(r) => void clearRanges([r], 'contents')}
        onclearranges={(ranges) => void clearRanges(ranges, 'contents')}
        onpaste={(pos, text) => void pasteAt(pos, text)}
        {copyText}
        oncopyclip={(range, ev) => copyOrCut(range, false, ev)}
        oncutclip={(range, ev) => copyOrCut(range, true, ev)}
        onpasteclip={handlePasteClip}
        onfill={(src, tgt) => void fillRange(src, tgt)}
        onfilldblclick={(src) => void fillDoubleClick(src)}
        onfillshortcut={(dir, rg) => void fillShortcut(dir, rg)}
        onautofit={(axis, idx) => void autofitAxis(axis, idx)}
        {outline}
        onoutline={(act) => void runOutlineAction(act)}
        cutRange={clipState?.cut && clipState.sourceSheet === sheet ? clipState.sourceRange : null}
        formulaRefs={gridFormulaRefs}
        pointSelectMode={pointSelectActive}
        onpointselect={handlePointSelect}
        oneditcursor={(start, end) => (formulaCursor = { start, end })}
        onselectcommit={() => void onSelectionCommit()}
        onfind={(replace) => (findDialog = { mode: replace ? 'replace' : 'find' })}
        ongoto={() => (findDialog = { mode: 'goto' })}
        showGridlines={viewOpts.showGridlines}
        showHeadings={viewOpts.showHeadings}
        frozenRows={frozen?.rows ?? 0}
        frozenCols={frozen?.cols ?? 0}
        filter={gridFilter}
        onfilter={openFilterMenu}
        onreach={(axis) => (axis === 'row' ? (extraRows += 100) : (extraCols += 10))}
        onresize={onResize}
        oncellpointerdown={() => (selectedChartId = null)}
        onblocked={() =>
          (notice = canEdit
            ? mode.kind === 'watching'
              ? m.drive_sheet_someone_editing({ name: mode.holder.name })
              : notice
            : m.drive_sheet_view_only())}
      >
        {#snippet overlay({ colLeft, rowTop, maxCol, maxRow })}
          {#if sheetCharts.length > 0 && editor}
            <ChartOverlay
              wb={editor.wb}
              calc={() => editor!.calc()}
              charts={sheetCharts}
              {colLeft}
              {rowTop}
              {maxCol}
              {maxRow}
              {locale}
              {rev}
              {editable}
              bind:selected={selectedChartId}
              onmove={moveChart}
              onedit={(placement) => (chartDialog = { mode: 'edit', placement })}
              ondelete={deleteChart}
            />
          {/if}
        {/snippet}
      </SheetGrid>
      {#if activePivot && pivotFieldsOpen}
        <PivotFields
          pivot={activePivot}
          {editable}
          onchange={(l) => void layoutPivot(l)}
          onrefresh={() => void refreshPivot()}
          ondelete={() => void deletePivot()}
          onclose={() => (pivotFieldsOpen = false)}
        />
      {:else if activePivot}
        <button
          type="button"
          class="{btn} self-start"
          onclick={() => (pivotFieldsOpen = true)}
          data-testid="xlsx-pivot-fields-open">{m.drive_sheet_pivot_fields()}</button
        >
      {/if}
      </div>
    {/if}

    <!-- Sheet tabs -->
    <div
      class="relative flex items-center gap-0.5 overflow-x-auto border-t bg-muted/30 px-1 py-1"
      role="tablist"
      aria-label={m.drive_sheet_tabs()}
      data-testid="xlsx-tabs"
    >
      {#each visibleSheets as s (s.part)}
        {@const tabColor = tabColors[s.name] ?? null}
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
            draggable={editable && renaming === null}
            class="inline-flex h-7 shrink-0 items-center gap-1 rounded px-2.5 text-sm {s.name ===
            sheet
              ? 'bg-background font-medium text-foreground shadow-sm'
              : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'}"
            style={tabColor ? `border-bottom: 3px solid ${tabColor};` : undefined}
            onclick={() => void pickSheet(s.name)}
            ondblclick={() => void startRename(s.name)}
            oncontextmenu={(e) => {
              if (!editable) return
              e.preventDefault()
              tabMenuSheet = tabMenuSheet === s.name ? null : s.name
            }}
            ondragstart={() => (draggedTab = s.name)}
            ondragover={(e) => {
              if (editable && draggedTab && draggedTab !== s.name) e.preventDefault()
            }}
            ondrop={(e) => {
              e.preventDefault()
              const from = draggedTab
              draggedTab = null
              if (!editable || !from || from === s.name) return
              const to = sheets.findIndex((x) => x.name === s.name)
              if (to >= 0) void change({ op: 'move_sheet', sheet: from, to })
            }}
            title={editable ? m.drive_sheet_tab_hint() : undefined}
            data-tab-color={tabColor ?? undefined}
            data-testid="xlsx-tab"
          >
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
          <button
            type="button"
            class="{btn} h-7 text-xs"
            aria-label={m.drive_sheet_tab_actions({ name: info.name })}
            onclick={() => (tabMenuSheet = tabMenuSheet === info.name ? null : info.name)}
            data-testid="xlsx-tab-menu-btn"
          >
            ⋯
          </button>
        {/if}
        {#if hiddenSheets.length > 0}
          <select
            class="h-7 rounded border border-input bg-background px-1.5 text-xs"
            value=""
            aria-label={m.drive_sheet_tab_hidden_list()}
            onchange={(e) => {
              const targetName = e.currentTarget.value
              e.currentTarget.value = ''
              if (targetName) {
                void change({
                  op: 'set_sheet_visibility',
                  sheet: targetName,
                  state: 'visible',
                }).then((ok) => {
                  if (ok) void pickSheet(targetName)
                })
              }
            }}
            data-testid="xlsx-unhide-sheet"
          >
            <option value="" disabled>{m.drive_sheet_tab_unhide()}</option>
            {#each hiddenSheets as hs (hs.part)}<option value={hs.name}>{hs.name}</option>{/each}
          </select>
        {/if}
      {:else if !canEdit}
        <span class="ml-auto px-2 text-xs text-muted-foreground" data-testid="xlsx-view-only"
          >{m.drive_sheet_view_only()}</span
        >
      {/if}
      {#if filterStatus}
        <span
          class="{editable || canEdit ? 'ml-auto' : ''} shrink-0 px-2 text-xs text-muted-foreground"
          role="status"
          data-testid="xlsx-filter-status">{filterStatus}</span
        >
      {/if}
    </div>

    {#if tabMenuSheet && editable}
      {@const tmName = tabMenuSheet}
      {@const tmIdx = sheets.findIndex((s) => s.name === tmName)}
      <div
        class="flex flex-wrap items-center gap-2 border-t bg-popover px-3 py-1.5 text-xs text-popover-foreground"
        role="menu"
        aria-label={m.drive_sheet_tab_actions({ name: tmName })}
        data-testid="xlsx-tab-menu"
      >
        <span class="font-medium">{tmName}:</span>
        <button
          type="button"
          class={btn}
          onclick={() => {
            const tm = tmName
            tabMenuSheet = null
            void startRename(tm)
          }}
          data-testid="xlsx-tab-action-rename">{m.drive_sheet_rename()}</button
        >
        <button
          type="button"
          class={btn}
          onclick={() => {
            const tm = tmName
            tabMenuSheet = null
            void change({ op: 'duplicate_sheet', sheet: tm })
          }}
          data-testid="xlsx-tab-action-duplicate">{m.drive_sheet_tab_duplicate()}</button
        >
        <button
          type="button"
          class={btn}
          disabled={tmIdx <= 0}
          onclick={() => {
            const tm = tmName
            const tmAt = tmIdx
            tabMenuSheet = null
            void change({ op: 'move_sheet', sheet: tm, to: Math.max(0, tmAt - 1) })
          }}
          data-testid="xlsx-tab-action-move-left">{m.drive_sheet_tab_move_left()}</button
        >
        <button
          type="button"
          class={btn}
          disabled={tmIdx < 0 || tmIdx >= sheets.length - 1}
          onclick={() => {
            const tm = tmName
            const tmAt = tmIdx
            tabMenuSheet = null
            void change({ op: 'move_sheet', sheet: tm, to: Math.min(sheets.length - 1, tmAt + 1) })
          }}
          data-testid="xlsx-tab-action-move-right">{m.drive_sheet_tab_move_right()}</button
        >
        <button
          type="button"
          class={btn}
          disabled={visibleSheets.length <= 1}
          onclick={() => {
            const tm = tmName
            tabMenuSheet = null
            const fallback = visibleSheets.find((s) => s.name !== tm)?.name
            void change({ op: 'set_sheet_visibility', sheet: tm, state: 'hidden' }).then((ok) => {
              if (ok && sheet === tm && fallback) sheet = fallback
            })
          }}
          data-testid="xlsx-tab-action-hide">{m.drive_sheet_tab_hide()}</button
        >
        <span class="text-muted-foreground">{m.drive_sheet_tab_color()}:</span>
        {#each ['#1F4E79', '#C00000', '#548235', '#BF8F00', '#7030A0'] as swatch (swatch)}
          <button
            type="button"
            class="size-4 rounded-full border border-border"
            style="background-color: {swatch}"
            aria-label="{m.drive_sheet_tab_color()} {swatch}"
            onclick={() => {
              const tm = tmName
              tabMenuSheet = null
              void change({ op: 'set_sheet_color', sheet: tm, color: swatch })
            }}
            data-testid="xlsx-tab-color-{swatch.slice(1)}"
          ></button>
        {/each}
        <button
          type="button"
          class={btn}
          onclick={() => {
            const tm = tmName
            tabMenuSheet = null
            void change({ op: 'set_sheet_color', sheet: tm, color: null })
          }}
          data-testid="xlsx-tab-color-clear">{m.drive_sheet_tab_color_clear()}</button
        >
      </div>
    {/if}

    <!-- Status bar: selection aggregates + view toggles + zoom -->
    <div
      class="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/20 px-3 py-1 text-xs text-muted-foreground"
      role="status"
      aria-label={m.drive_sheet_status_bar()}
      data-testid="xlsx-status-bar"
    >
      <div class="flex items-center gap-4 tabular-nums" data-testid="xlsx-selection-stats">
        {#if selStats && selStats.count > 0}
          <span data-testid="xlsx-stat-count"
            >{m.drive_sheet_stat_count({ value: fmtStatNum(selStats.count) })}</span
          >
          {#if selStats.numericCount > 0}
            <span data-testid="xlsx-stat-sum"
              >{m.drive_sheet_stat_sum({ value: fmtStatNum(selStats.sum) })}</span
            >
            {#if selStats.average !== null}
              <span data-testid="xlsx-stat-avg"
                >{m.drive_sheet_stat_avg({ value: fmtStatNum(selStats.average) })}</span
              >
            {/if}
          {/if}
        {/if}
      </div>
      {#if info?.kind === 'worksheet'}
        <div class="flex items-center gap-3">
          {#if editable}
            <label class="flex items-center gap-1.5">
              <input
                type="checkbox"
                class="accent-primary"
                checked={viewOpts.showGridlines}
                onchange={(e) =>
                  void change({
                    op: 'set_view_options',
                    sheet,
                    showGridlines: e.currentTarget.checked,
                  })}
                data-testid="xlsx-toggle-gridlines"
              />
              {m.drive_sheet_view_gridlines()}
            </label>
            <label class="flex items-center gap-1.5">
              <input
                type="checkbox"
                class="accent-primary"
                checked={viewOpts.showHeadings}
                onchange={(e) =>
                  void change({
                    op: 'set_view_options',
                    sheet,
                    showHeadings: e.currentTarget.checked,
                  })}
                data-testid="xlsx-toggle-headings"
              />
              {m.drive_sheet_view_headings()}
            </label>
            <label class="flex items-center gap-1.5">
              <span>{m.drive_sheet_zoom()}</span>
              <select
                class="h-6 rounded border border-input bg-background px-1.5 text-xs text-foreground"
                value={String(viewOpts.zoomScale)}
                onchange={(e) =>
                  void change({
                    op: 'set_view_options',
                    sheet,
                    zoomScale: Number(e.currentTarget.value),
                  })}
                data-testid="xlsx-zoom"
              >
                {#each [50, 75, 100, 125, 150, 200] as pct (pct)}
                  <option value={String(pct)}>{pct}%</option>
                {/each}
              </select>
            </label>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

{#if filterMenu && menuFilter}
  {@const fm = filterMenu}
  <FilterMenu
    col={colName(fm.col)}
    choices={fm.choices}
    current={menuFilter.columns.find((c) => c.col === fm.col)}
    at={fm.at}
    {editable}
    onapply={(values, blanks) => void applyFilter(fm.col, values, blanks)}
    onsort={(descending) => void sortFromFilter(fm.col, descending)}
    onclose={() => {
      filterMenu = null
      grid?.focus()
    }}
  />
{/if}

{#if creating}
  {@const cr = creating}
  <TableDialog
    kind={cr.kind}
    range={cr.range}
    header={cr.header}
    at={activeRef}
    oncreate={(out) => void created(out)}
    onclose={() => {
      creating = null
      grid?.focus()
    }}
  />
{/if}

{#if sorting}
  {@const st = sorting}
  <SortDialog
    range={st.range}
    header={st.header}
    first={st.first}
    {headerText}
    onsort={(keys, header) => {
      const range = st.range
      sorting = null
      void sortBy(keys, { range, header })
    }}
    onclose={() => (sorting = null)}
  />
{/if}

{#if chartDialog && editor}
  {@const cd = chartDialog}
  <ChartDialog
    mode={cd.mode}
    {sheet}
    wb={editor.wb}
    initialRange={cd.mode === 'create' ? cd.range : ''}
    placement={cd.mode === 'edit' ? cd.placement : null}
    onsubmit={applyChartOp}
    ondelete={cd.mode === 'edit' ? () => deleteChart(cd.placement.id) : undefined}
    onclose={() => {
      chartDialog = null
      grid?.focus()
    }}
  />
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

{#if findDialog && editor}
  <FindDialog
    mode={findDialog.mode}
    {editable}
    namedTargets={listGoToNames(editor.wb, sheet).map((t) => ({
      name: t.name,
      label: `${t.sheet}!${rangeName(t.range)}`,
    }))}
    hits={findHits}
    hitIndex={findHitIndex}
    lastQuery={findLastQuery}
    onsearch={runFindSearch}
    onnavigatehit={navigateFindHit}
    onreplaceone={(opts) => void runReplaceOne(opts)}
    onreplaceall={(opts) => void runReplaceAll(opts)}
    ongoto={goToTarget}
    onclose={() => {
      findDialog = null
      grid?.focus()
    }}
  />
{/if}

{#if pageSetupOpen && editor && info?.kind === 'worksheet'}
  <PageSetupDialog
    initial={pageSetupOf(editor.wb, info.name)}
    {editable}
    exporting={exportingPdf}
    onsave={(patch: {
      orientation: 'portrait' | 'landscape'
      paperSize: PaperSize
      scale: number
      fitToWidth: number | null
      printGridlines: boolean
      printHeadings: boolean
      printArea: string | null
      repeatRows: string | null
      repeatCols: string | null
    }) => void change({ op: 'set_page_setup', sheet, ...patch })}
    onexportpdf={(opts) => void exportPdf(opts)}
    onclose={() => {
      pageSetupOpen = false
      grid?.focus()
    }}
  />
{/if}

<Dialog.Root
  open={customFmtOpen}
  onOpenChange={(open) => {
    if (!open) customFmtOpen = false
  }}
>
  <Dialog.Content class="max-w-sm" data-testid="xlsx-custom-format-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.drive_sheet_fmt_custom()}</Dialog.Title>
      <Dialog.Description>{m.drive_sheet_fmt_custom_prompt()}</Dialog.Description>
    </Dialog.Header>
    <form
      class="flex flex-col gap-3"
      onsubmit={(e) => {
        e.preventDefault()
        const code = customFmtInput.trim()
        customFmtOpen = false
        if (code) void applyNumberFormat(code)
        grid?.focus()
      }}
    >
      <input
        type="text"
        class="h-8 w-full rounded-md border border-input bg-background px-2 font-mono text-sm"
        bind:value={customFmtInput}
        data-testid="xlsx-custom-format-input"
      />
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => (customFmtOpen = false)}
          >{m.drive_sheet_cancel()}</Button
        >
        <Button type="submit" data-testid="xlsx-custom-format-apply"
          >{m.drive_sheet_go_ahead()}</Button
        >
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<style>
  .chart-sheet-host {
    min-height: 24rem;
    height: 28rem;
    flex: 1 1 0%;
    overflow: hidden;
    padding: 16px;
    box-sizing: border-box;
  }
</style>
