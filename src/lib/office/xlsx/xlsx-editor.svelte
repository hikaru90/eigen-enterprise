<script lang="ts">
  import type { OfficeViewerProps } from '../viewers'
  import type { StylePatch } from './format-cells'
  import ArrowDownAZIcon from '@lucide/svelte/icons/arrow-down-a-z'
  import ArrowDownZAIcon from '@lucide/svelte/icons/arrow-down-z-a'
  import ChartColumnIcon from '@lucide/svelte/icons/chart-column'
  import DownloadIcon from '@lucide/svelte/icons/download'
  import EyeOffIcon from '@lucide/svelte/icons/eye-off'
  import FunnelIcon from '@lucide/svelte/icons/funnel'
  import InfoIcon from '@lucide/svelte/icons/info'
  import LoaderIcon from '@lucide/svelte/icons/loader-circle'
  import PlusIcon from '@lucide/svelte/icons/plus'
  import Redo2Icon from '@lucide/svelte/icons/redo-2'
  import Undo2Icon from '@lucide/svelte/icons/undo-2'
  import { onMount, tick } from 'svelte'
  import { beforeNavigate } from '$app/navigation'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import * as AlertDialog from '$lib/components/ui/alert-dialog'
  import { Button } from '$lib/components/ui/button'
  import { driveApi } from '$lib/drive/api'
  import { parseClipboardBlock } from '$lib/drive/csv-grid'
  import { driveShownError } from '$lib/drive/shown-error'
  import type { ShownError } from '$lib/errors/agent-report'
  import { m } from '$lib/paraglide/messages.js'
  import { getLocale } from '$lib/paraglide/runtime'
  import { OFFICE_MIME } from '../kinds'
  import { OpcError } from '../ooxml/package'
  import { createLiveSheet, type LiveSheet } from './collab/client'
  import { PEER_COLORS, type LogEntry, type Peer } from './collab/protocol'
  import { createSheetEditor, workbookNotes, type SheetEditor, type WorkbookNote } from './editor'
  import { autoFilterOf, columnChoices, currentRegion, type FilterChoice } from './filter'
  import FilterMenu from './filter-menu.svelte'
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
  import { borderCss, fontFamilyCss, verticalOf } from './grid-style'
  import { toShownFormula, XlsxLossError, type CellWrite, type Loss, type SheetOp } from './ops'
  import { frozenOf } from './panes'
  import { cellKey, cellName, colName, MAX_COLS, MAX_ROWS, parseRange, rangeName, type Range } from './ref'
  import SheetGrid, { type GridCell, type GridPeer, type Pos } from './sheet-grid.svelte'
  import { guessHeader, type SortKey } from './sort'
  import SortDialog from './sort-dialog.svelte'
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
   * Live `.xlsx` workbooks co-edit in real time over a server-authoritative
   * `SheetOp` log and SSE stream (`./collab/client.ts`): editors stream ops and
   * peer selections concurrently without exclusive locks, while viewers receive
   * live updates read-only. Converted `.xls`/`.ods` previews (`source` prop)
   * stay local and read-only.
   */
  let {
    fileId,
    name,
    canEdit,
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
  type Mode = { kind: 'open' } | { kind: 'conflict'; message: string }
  let mode = $state<Mode>({ kind: 'open' })
  let liveCanEdit = $state(false)
  let peers = $state<Peer[]>([])
  let pendingCount = $state(0)
  let connected = $state(true)
  let offlineError = $state<string | null>(null)
  let savedAt = $state<Date | null>(null)
  let saveError = $state<string | null>(null)
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
  let renaming = $state<string | null>(null)
  let renameText = $state('')
  let confirm = $state<{ op: SheetOp; title: string; losses: Loss[] } | null>(null)
  let grid = $state<ReturnType<typeof SheetGrid> | null>(null)
  let filterMenu = $state<{ col: number; at: DOMRect; choices: FilterChoice[] } | null>(null)
  let sorting = $state<{ range: Range; header: boolean; first: number } | null>(null)

  let editor: SheetEditor | null = null
  let live: LiveSheet | null = null
  let stream: EventSource | null = null
  let clientId = ''
  let presenceTimer: ReturnType<typeof setTimeout> | null = null
  let lastPresenceKey = ''
  let wasDisconnected = false

  async function sha256(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  // ---------------------------------------------------------------------------
  // What is on screen

  const ready = $derived(view.status === 'ready')
  const editable = $derived(canEdit && liveCanEdit && ready && mode.kind === 'open')
  const syncingNow = $derived(pendingCount > 0 && offlineError === null && connected)
  const peerColorHex = (index: number) => PEER_COLORS[Math.abs(index) % PEER_COLORS.length] ?? PEER_COLORS[0]!
  const gridPeers = $derived.by<GridPeer[]>(() => {
    void rev
    if (!info || info.kind !== 'worksheet') return []
    const activeName = info.name.toLowerCase()
    const out: GridPeer[] = []
    for (const p of peers) {
      if (!p.sheet || !p.range || p.sheet.toLowerCase() !== activeName) continue
      const parsed = parseRange(p.range)
      if (!parsed) continue
      out.push({
        clientId: p.clientId,
        name: p.name,
        color: peerColorHex(p.color),
        range: parsed,
      })
    }
    return out
  })
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

  /** Sort, filter and frozen panes of the sheet on screen (read from its XML). */
  const frozen = $derived.by(() => {
    void rev
    return editor && info?.kind === 'worksheet' ? frozenOf(editor.wb, info.name) : null
  })
  const autoFilter = $derived.by(() => {
    void rev
    return editor && info?.kind === 'worksheet' ? autoFilterOf(editor.wb, info.name) : null
  })
  const gridFilter = $derived(
    autoFilter
      ? {
          range: autoFilter.range,
          filtered: (c: number) => autoFilter.columns.some((x) => x.col === c),
        }
      : null,
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
    const plain = styles.xf(0)
    const calc = ed.calc()
    const date1904 = ed.wb.date1904
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
      // An empty cell can still show a value: a dynamic array spilled into it.
      if (!cell && out.value === null && !out.kept) {
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
      const family = fontFamilyCss(st, plain)
      if (family) css.push(family)
      css.push(...borderCss(st.border, { ...near, filled: !!st.fill }))
      return {
        text: shown.text,
        align,
        css: css.join('; '),
        wrap: st.wrap,
        vertical: verticalOf(st),
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
    }
  }

  // ---------------------------------------------------------------------------
  // Loading

  onMount(() => {
    void load()
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (pendingCount === 0) return
      live?.resend()
      event.preventDefault()
    }
    const onOnline = () => {
      if (!source && live && mode.kind === 'open') retrySync()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('online', onOnline)
      disconnectLive()
    }
  })

  beforeNavigate((nav) => {
    if (pendingCount === 0) return
    live?.resend()
    if (nav.type === 'leave' || !nav.to || nav.type === 'popstate') return
    if (!window.confirm(m.drive_sheet_leave_unsaved())) nav.cancel()
  })

  function clearPresenceTimer() {
    if (presenceTimer !== null) clearTimeout(presenceTimer)
    presenceTimer = null
  }

  function disconnectLive() {
    clearPresenceTimer()
    stream?.close()
    stream = null
    live?.close()
    live = null
    connected = true
    wasDisconnected = false
  }

  async function load() {
    disconnectLive()
    try {
      if (source) {
        const next = createSheetEditor(await source())
        liveCanEdit = false
        peers = []
        finishOpen(next)
        return
      }
      let joined = await driveApi.sheetLiveJoin(fileId)
      let bytes = await driveApi.readBytes(fileId)
      if ((await sha256(bytes)) !== joined.baseSha256) {
        joined = await driveApi.sheetLiveJoin(fileId)
        bytes = await driveApi.readBytes(fileId)
      }
      const tabId = crypto.randomUUID()
      clientId = tabId
      let replica!: LiveSheet
      replica = createLiveSheet({
        bytes,
        baseSeq: joined.baseSeq,
        entries: joined.entries,
        clientId: tabId,
        newId: () => crypto.randomUUID(),
        transport: {
          submit: (req) => driveApi.sheetLiveSubmit(fileId, req),
          entriesAfter: (seq) => driveApi.sheetLiveEntries(fileId, seq),
        },
        events: {
          onChanged: (by) => {
            if (live !== replica) return
            if (by?.body.kind === 'change') {
              for (const op of by.body.ops) {
                if (op.op === 'rename_sheet' && op.sheet.toLowerCase() === sheet.toLowerCase()) {
                  sheet = replica.wb.findSheet(op.name)?.info.name ?? op.name
                }
              }
            }
            if (!replica.wb.findSheet(sheet)) {
              const all = replica.wb.sheets()
              if (all.length > 0) sheet = (all.find((s) => s.state === 'visible') ?? all[0]!).name
            }
            notes = workbookNotes(replica)
            rev++
            sendPresenceSoon()
          },
          onRejected: (reason) => {
            if (live !== replica) return
            notice = reason ? m.drive_sheet_rejected({ reason }) : m.drive_sheet_rejected_gone()
          },
          onReload: (reason) => {
            if (live !== replica) return
            conflicted(reason)
          },
          onOffline: (err) => {
            if (live !== replica) return
            offlineError = err instanceof Error ? err.message : String(err)
          },
          onPending: (count) => {
            if (live !== replica) return
            pendingCount = count
            if (count === 0) offlineError = null
          },
        },
      })
      live = replica
      liveCanEdit = joined.canEdit
      peers = joined.peers.filter((p) => p.clientId !== tabId)
      pendingCount = 0
      offlineError = null
      saveError = null
      savedAt = null
      lastPresenceKey = ''
      mode = { kind: 'open' }
      finishOpen(replica)
      connectStream(replica, tabId)
      sendPresenceNow()
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

  function finishOpen(next: SheetEditor) {
    editor = next
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

  function connectStream(replica: LiveSheet, tabId: string) {
    stream?.close()
    wasDisconnected = false
    const es = driveApi.sheetLiveStream(fileId, tabId, replica.seq())
    stream = es
    es.addEventListener('open', () => {
      if (live !== replica) return
      connected = true
      offlineError = null
      if (wasDisconnected) {
        wasDisconnected = false
        void driveApi
          .sheetLiveEntries(fileId, replica.seq())
          .then((more) => {
            if (live !== replica) return
            replica.receive(more)
            replica.resend()
          })
          .catch((err) => {
            if (live === replica) offlineError = err instanceof Error ? err.message : String(err)
          })
      } else {
        replica.resend()
      }
      sendPresenceNow()
    })
    es.addEventListener('entry', (ev) => {
      if (live !== replica) return
      replica.receive([JSON.parse((ev as MessageEvent<string>).data) as LogEntry])
    })
    es.addEventListener('peers', (ev) => {
      if (live !== replica) return
      const list = JSON.parse((ev as MessageEvent<string>).data) as Peer[]
      peers = list.filter((p) => p.clientId !== tabId)
    })
    es.addEventListener('saved', (ev) => {
      if (live !== replica) return
      const d = JSON.parse((ev as MessageEvent<string>).data) as { seq: number; at: string }
      saveError = null
      savedAt = new Date(d.at)
    })
    es.addEventListener('reset', (ev) => {
      if (live !== replica) return
      const d = JSON.parse((ev as MessageEvent<string>).data) as { reason: string }
      conflicted(d.reason)
    })
    es.addEventListener('save_failed', (ev) => {
      if (live !== replica) return
      const d = JSON.parse((ev as MessageEvent<string>).data) as { error: string }
      saveError = d.error
      notice = m.drive_sheet_save_warning({ error: d.error })
    })
    es.addEventListener('error', () => {
      if (live !== replica) return
      connected = false
      wasDisconnected = true
    })
  }

  function retrySync() {
    if (!live || mode.kind !== 'open') return
    offlineError = null
    const replica = live
    // An explicit retry opens the stream again unless it is up (a stream stuck reconnecting too).
    if (!connected || !stream || stream.readyState === EventSource.CLOSED) {
      connectStream(replica, clientId)
    } else {
      void driveApi
        .sheetLiveEntries(fileId, replica.seq())
        .then((more) => {
          if (live === replica) replica.receive(more)
        })
        .catch(() => {})
    }
    replica.resend()
    sendPresenceNow()
  }

  function currentPresenceRange(): string | null {
    if (!info || info.kind !== 'worksheet') return null
    return rangeName({
      top: Math.min(active.row, anchor.row),
      bottom: Math.max(active.row, anchor.row),
      left: Math.min(active.col, anchor.col),
      right: Math.max(active.col, anchor.col),
    })
  }

  function sendPresenceNow() {
    clearPresenceTimer()
    if (source || !live || !info || mode.kind !== 'open' || view.status !== 'ready') return
    const range = currentPresenceRange()
    const key = `${info.name}\0${range ?? ''}`
    if (key === lastPresenceKey) return
    lastPresenceKey = key
    void driveApi.sheetLivePresence(fileId, { clientId, sheet: info.name, range }).catch(() => {})
  }

  function sendPresenceSoon() {
    if (source || !live || mode.kind !== 'open' || view.status !== 'ready') return
    clearPresenceTimer()
    presenceTimer = setTimeout(() => {
      presenceTimer = null
      sendPresenceNow()
    }, 60)
  }

  /** The file was replaced outside the co-editing session: edits stop; reload the newest version. */
  function conflicted(message: string) {
    grid?.finishEdit(false)
    disconnectLive()
    mode = { kind: 'conflict', message }
  }

  /** After a reset/conflict: reload the newer version from the server and rejoin co-editing. */
  async function reloadNewest() {
    notice = null
    failure = null
    await load()
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

  /** Applies an operation locally and queues it for co-editing sync; one with losses asks first. */
  async function change(op: SheetOp, opts: { acceptLosses?: boolean } = {}): Promise<boolean> {
    if (!editor || !editable) return false
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
    notes = workbookNotes(editor)
    rev++
    sendPresenceSoon()
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

  // ---------------------------------------------------------------------------
  // Cell format and sizes (./format-cells.ts; the same operations as drive.sheet_format)

  async function applyStyle(patch: StylePatch) {
    if (editing) grid?.finishEdit(true)
    await change({ op: 'set_style', sheet, range: rangeName(sel), style: patch })
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

  /** A dragged edge: pixels → Excel characters (columns) or points (rows, in quarter points). */
  function onResize(axis: 'col' | 'row', index: number, px: number) {
    if (axis === 'col') void setColumnWidth(pxToWidth(px), index)
    else void setRowHeight(Math.round(px * 3) / 4, index)
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
    if (autoFilter) await change({ op: 'set_autofilter', sheet, range: null })
    else await change({ op: 'set_autofilter', sheet, range: rangeName(sel) })
    grid?.focus()
  }

  function openFilterMenu(col: number, at: DOMRect) {
    if (!editor) return
    try {
      filterMenu = { col, at, choices: columnChoices(editor, sheet, col, locale) }
    } catch (err) {
      failure = shown(err)
    }
  }

  async function applyFilter(col: number, values: string[] | null, blanks: boolean) {
    filterMenu = null
    await change({ op: 'filter_column', sheet, col, values, blanks })
    grid?.focus()
  }

  async function sortFromFilter(col: number, descending: boolean) {
    filterMenu = null
    if (autoFilter) await sortBy([{ col, descending }], { range: autoFilter.range, header: true })
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

  async function undo() {
    if (!editable || !editor?.canUndo()) return
    const r = editor.undo()
    if (r?.focus && editor.wb.findSheet(r.focus)) sheet = editor.wb.findSheet(r.focus)!.name
    afterHistory()
  }
  async function redo() {
    if (!editable || !editor?.canRedo()) return
    const r = editor.redo()
    if (r?.focus && editor.wb.findSheet(r.focus)) sheet = editor.wb.findSheet(r.focus)!.name
    afterHistory()
  }
  function afterHistory() {
    if (!editor) return
    if (!editor.wb.findSheet(sheet)) sheet = editor.wb.sheets()[0]!.name
    notes = workbookNotes(editor)
    rev++
    sendPresenceSoon()
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
    sendPresenceNow()
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
    source
      ? ''
      : offlineError !== null
        ? pendingCount > 0
          ? m.drive_sheet_offline_pending({ count: pendingCount })
          : m.drive_sheet_reconnecting()
        : pendingCount > 0
          ? connected
            ? m.drive_sheet_syncing()
            : m.drive_sheet_offline_pending({ count: pendingCount })
          : !connected
            ? m.drive_sheet_reconnecting()
            : saveError
              ? m.drive_sheet_save_failed()
              : savedAt
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
        <span
          class="ml-auto flex items-center gap-1.5 px-2 text-xs text-muted-foreground"
          role="status"
          data-testid="xlsx-save-state"
        >
          {#if syncingNow}<LoaderIcon
              class="size-3.5 animate-spin"
              aria-hidden="true"
            />{/if}
          {saveLabel}
          {#if offlineError !== null || saveError !== null || (!connected && pendingCount > 0)}
            <button type="button" class="underline" onclick={retrySync} data-testid="xlsx-retry"
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
          onstyle={(patch) => void applyStyle(patch)}
          onwidth={(chars) => void setColumnWidth(chars)}
          onheight={(points) => void setRowHeight(points)}
        />
      {/if}
    {/if}

    {#if mode.kind === 'conflict'}
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
      {#if !source && peers.length > 0}
        <div
          class="flex shrink-0 items-center gap-1"
          aria-label={m.drive_sheet_peers_label()}
          data-testid="xlsx-peers"
        >
          {#each peers as p (p.clientId)}
            {@const hex = peerColorHex(p.color)}
            <span
              class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
              style="border-color: {hex}40; background-color: {hex}14;"
              title={p.editing ? p.name : m.drive_sheet_peer_viewing({ name: p.name })}
              data-testid="xlsx-peer"
              data-peer-id={p.clientId}
            >
              <span class="size-2 shrink-0 rounded-full" style="background-color: {hex};" aria-hidden="true"></span>
              <span class="max-w-28 truncate">{p.name}</span>
            </span>
          {/each}
        </div>
      {/if}
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
        frozenRows={frozen?.rows ?? 0}
        frozenCols={frozen?.cols ?? 0}
        filter={gridFilter}
        onfilter={openFilterMenu}
        onreach={(axis) => (axis === 'row' ? (extraRows += 100) : (extraCols += 10))}
        onresize={onResize}
        peers={gridPeers}
        onselect={() => sendPresenceSoon()}
        onblocked={() => (notice = m.drive_sheet_view_only())}
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
      {#if filterStatus}
        <span
          class="{editable || canEdit ? 'ml-auto' : ''} shrink-0 px-2 text-xs text-muted-foreground"
          role="status"
          data-testid="xlsx-filter-status">{filterStatus}</span
        >
      {/if}
    </div>
  </div>
{/if}

{#if filterMenu && autoFilter}
  {@const fm = filterMenu}
  <FilterMenu
    col={colName(fm.col)}
    choices={fm.choices}
    current={autoFilter.columns.find((c) => c.col === fm.col)}
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
