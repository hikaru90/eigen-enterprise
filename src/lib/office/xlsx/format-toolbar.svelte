<script lang="ts">
  import type { StylePatch } from './format-cells'
  import type { BorderPreset, BorderStyle } from './style-choices'
  import type { CellStyle } from './styles'
  import AlignMiddleIcon from '@lucide/svelte/icons/align-vertical-justify-center'
  import AlignBottomIcon from '@lucide/svelte/icons/align-vertical-justify-end'
  import AlignTopIcon from '@lucide/svelte/icons/align-vertical-justify-start'
  import BaselineIcon from '@lucide/svelte/icons/baseline'
  import BoldIcon from '@lucide/svelte/icons/bold'
  import ItalicIcon from '@lucide/svelte/icons/italic'
  import PaintBucketIcon from '@lucide/svelte/icons/paint-bucket'
  import StrikethroughIcon from '@lucide/svelte/icons/strikethrough'
  import AlignCenterIcon from '@lucide/svelte/icons/text-align-center'
  import AlignRightIcon from '@lucide/svelte/icons/text-align-end'
  import AlignLeftIcon from '@lucide/svelte/icons/text-align-start'
  import WrapIcon from '@lucide/svelte/icons/text-wrap'
  import UnderlineIcon from '@lucide/svelte/icons/underline'
  import XIcon from '@lucide/svelte/icons/x'
  import { m } from '$lib/paraglide/messages.js'

  /**
   * The spreadsheet's cell format bar: font family and size, bold, italic,
   * underline, strikethrough, text and fill colour, horizontal and vertical
   * alignment, wrap, borders, and the active column's width and row's height.
   * It shows the active cell's look; each control hands one change to the
   * page (`onstyle`, `onwidth`, `onheight`), which applies it to the
   * selection — the same operations drive.sheet_format makes.
   */
  let {
    style,
    plainFont,
    width,
    height,
    onstyle,
    onwidth,
    onheight,
  }: {
    /** The active cell's look. */
    style: CellStyle
    /** The workbook's plain font (shown when a cell names none). */
    plainFont: string | null
    /** The active column's width (Excel characters) and row's height (points). */
    width: number
    height: number
    onstyle: (patch: StylePatch) => void
    /** null: back to the sheet's default. */
    onwidth: (chars: number | null) => void
    onheight: (points: number | null) => void
  } = $props()

  const FONTS = [
    'Aptos',
    'Arial',
    'Calibri',
    'Cambria',
    'Courier New',
    'Georgia',
    'Helvetica',
    'Times New Roman',
    'Verdana',
  ]
  const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72]
  const LINE_STYLES: BorderStyle[] = ['thin', 'medium', 'thick', 'dashed', 'dotted', 'double']

  const font = $derived(style.font.name ?? plainFont ?? 'Calibri')
  const fonts = $derived(FONTS.includes(font) ? FONTS : [font, ...FONTS])
  const size = $derived(style.font.sizePt ?? 11)
  const sizes = $derived(SIZES.includes(size) ? SIZES : [...SIZES, size].sort((a, b) => a - b))
  const horizontal = $derived(style.horizontal ?? 'general')
  const vertical = $derived(style.vertical ?? 'bottom')

  let lineStyle = $state<BorderStyle>('thin')
  let lineColor = $state<string | null>(null)

  const presetLabel = (p: BorderPreset): string =>
    ({
      all: m.drive_sheet_fmt_border_all(),
      outer: m.drive_sheet_fmt_border_outer(),
      inner: m.drive_sheet_fmt_border_inner(),
      top: m.drive_sheet_fmt_border_top(),
      bottom: m.drive_sheet_fmt_border_bottom(),
      left: m.drive_sheet_fmt_border_left(),
      right: m.drive_sheet_fmt_border_right(),
      none: m.drive_sheet_fmt_border_none(),
    })[p]
  const lineLabel = (s: BorderStyle): string =>
    ({
      thin: m.drive_sheet_fmt_line_thin(),
      medium: m.drive_sheet_fmt_line_medium(),
      thick: m.drive_sheet_fmt_line_thick(),
      dashed: m.drive_sheet_fmt_line_dashed(),
      dotted: m.drive_sheet_fmt_line_dotted(),
      double: m.drive_sheet_fmt_line_double(),
    })[s as 'thin']
  const H_ALIGN = [
    { v: 'left', label: m.drive_sheet_fmt_align_left(), Icon: AlignLeftIcon },
    { v: 'center', label: m.drive_sheet_fmt_align_center(), Icon: AlignCenterIcon },
    { v: 'right', label: m.drive_sheet_fmt_align_right(), Icon: AlignRightIcon },
  ] as const
  const V_ALIGN = [
    { v: 'top', label: m.drive_sheet_fmt_align_top(), Icon: AlignTopIcon },
    { v: 'center', label: m.drive_sheet_fmt_align_middle(), Icon: AlignMiddleIcon },
    { v: 'bottom', label: m.drive_sheet_fmt_align_bottom(), Icon: AlignBottomIcon },
  ] as const
  const PRESETS: BorderPreset[] = [
    'all',
    'outer',
    'inner',
    'top',
    'bottom',
    'left',
    'right',
    'none',
  ]

  function onBorder(select: HTMLSelectElement) {
    const preset = select.value as BorderPreset | ''
    select.value = ''
    if (!preset) return
    onstyle({
      border:
        preset === 'none'
          ? { preset }
          : { preset, style: lineStyle, ...(lineColor ? { color: lineColor } : {}) },
    })
  }

  function sizeIn(text: string, max: number): number | null | undefined {
    if (text.trim() === '') return null
    const n = Number(text.replace(',', '.'))
    return Number.isFinite(n) && n > 0 && n <= max ? n : undefined
  }

  const round2 = (n: number) => Math.round(n * 100) / 100

  const btn =
    'inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40'
  const on = 'bg-muted text-foreground'
  const field = 'h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground'
  const sep = 'mx-1 h-5 w-px bg-border'
</script>

<div
  class="flex flex-wrap items-center gap-1 border-b px-2 py-1"
  role="toolbar"
  aria-label={m.drive_sheet_fmt_toolbar()}
  data-testid="xlsx-format-bar"
>
  <select
    class="{field} w-36"
    value={font}
    aria-label={m.drive_sheet_fmt_font()}
    onchange={(e) => onstyle({ fontName: e.currentTarget.value })}
    data-testid="xlsx-font"
  >
    {#each fonts as f (f)}<option value={f}>{f}</option>{/each}
  </select>
  <select
    class="{field} w-16"
    value={String(size)}
    aria-label={m.drive_sheet_fmt_size()}
    onchange={(e) => onstyle({ fontSize: Number(e.currentTarget.value) })}
    data-testid="xlsx-font-size"
  >
    {#each sizes as s (s)}<option value={String(s)}>{s}</option>{/each}
  </select>
  <span class={sep} aria-hidden="true"></span>
  <button
    type="button"
    class="{btn} {style.font.bold ? on : ''}"
    aria-pressed={style.font.bold}
    aria-label={m.drive_sheet_fmt_bold()}
    aria-keyshortcuts="Control+B Meta+B"
    title={m.drive_sheet_fmt_bold()}
    onclick={() => onstyle({ bold: !style.font.bold })}
    data-testid="xlsx-bold"><BoldIcon class="size-4" aria-hidden="true" /></button
  >
  <button
    type="button"
    class="{btn} {style.font.italic ? on : ''}"
    aria-pressed={style.font.italic}
    aria-label={m.drive_sheet_fmt_italic()}
    aria-keyshortcuts="Control+I Meta+I"
    title={m.drive_sheet_fmt_italic()}
    onclick={() => onstyle({ italic: !style.font.italic })}
    data-testid="xlsx-italic"><ItalicIcon class="size-4" aria-hidden="true" /></button
  >
  <button
    type="button"
    class="{btn} {style.font.underline ? on : ''}"
    aria-pressed={style.font.underline}
    aria-label={m.drive_sheet_fmt_underline()}
    aria-keyshortcuts="Control+U Meta+U"
    title={m.drive_sheet_fmt_underline()}
    onclick={() => onstyle({ underline: !style.font.underline })}
    data-testid="xlsx-underline"><UnderlineIcon class="size-4" aria-hidden="true" /></button
  >
  <button
    type="button"
    class="{btn} {style.font.strike ? on : ''}"
    aria-pressed={style.font.strike}
    aria-label={m.drive_sheet_fmt_strike()}
    title={m.drive_sheet_fmt_strike()}
    onclick={() => onstyle({ strike: !style.font.strike })}
    data-testid="xlsx-strike"><StrikethroughIcon class="size-4" aria-hidden="true" /></button
  >
  <span class={sep} aria-hidden="true"></span>
  <label class="{btn} relative cursor-pointer" title={m.drive_sheet_fmt_text_color()}>
    <span class="flex flex-col items-center" aria-hidden="true">
      <BaselineIcon class="size-4" />
      <span
        class="-mt-0.5 h-1 w-4 rounded-sm border border-border"
        style="background-color: {style.font.color ?? 'var(--foreground)'}"
      ></span>
    </span>
    <input
      type="color"
      class="sr-only"
      value={style.font.color ?? '#000000'}
      aria-label={m.drive_sheet_fmt_text_color()}
      onchange={(e) => onstyle({ fontColor: e.currentTarget.value.toUpperCase() })}
      data-testid="xlsx-text-color"
    />
  </label>
  <label class="{btn} relative cursor-pointer" title={m.drive_sheet_fmt_fill()}>
    <span class="flex flex-col items-center" aria-hidden="true">
      <PaintBucketIcon class="size-4" />
      <span
        class="-mt-0.5 h-1 w-4 rounded-sm border border-border"
        style="background-color: {style.fill ?? 'transparent'}"
      ></span>
    </span>
    <input
      type="color"
      class="sr-only"
      value={style.fill ?? '#FFFFFF'}
      aria-label={m.drive_sheet_fmt_fill()}
      onchange={(e) => onstyle({ fill: e.currentTarget.value.toUpperCase() })}
      data-testid="xlsx-fill"
    />
  </label>
  <button
    type="button"
    class={btn}
    disabled={!style.fill}
    aria-label={m.drive_sheet_fmt_no_fill()}
    title={m.drive_sheet_fmt_no_fill()}
    onclick={() => onstyle({ fill: null })}
    data-testid="xlsx-no-fill"><XIcon class="size-3.5" aria-hidden="true" /></button
  >
  <span class={sep} aria-hidden="true"></span>
  {#each H_ALIGN as a (a.v)}
    <button
      type="button"
      class="{btn} {horizontal === a.v ? on : ''}"
      aria-pressed={horizontal === a.v}
      aria-label={a.label}
      title={a.label}
      onclick={() => onstyle({ horizontal: horizontal === a.v ? 'general' : a.v })}
      data-testid="xlsx-align-{a.v}"><a.Icon class="size-4" aria-hidden="true" /></button
    >
  {/each}
  {#each V_ALIGN as a (a.v)}
    <button
      type="button"
      class="{btn} {vertical === a.v ? on : ''}"
      aria-pressed={vertical === a.v}
      aria-label={a.label}
      title={a.label}
      onclick={() => onstyle({ vertical: a.v })}
      data-testid="xlsx-valign-{a.v}"><a.Icon class="size-4" aria-hidden="true" /></button
    >
  {/each}
  <button
    type="button"
    class="{btn} {style.wrap ? on : ''}"
    aria-pressed={style.wrap}
    aria-label={m.drive_sheet_fmt_wrap()}
    title={m.drive_sheet_fmt_wrap()}
    onclick={() => onstyle({ wrap: !style.wrap })}
    data-testid="xlsx-wrap"><WrapIcon class="size-4" aria-hidden="true" /></button
  >
  <span class={sep} aria-hidden="true"></span>
  <select
    class="{field} w-32"
    value=""
    aria-label={m.drive_sheet_fmt_borders()}
    onchange={(e) => onBorder(e.currentTarget)}
    data-testid="xlsx-borders"
  >
    <option value="" disabled>{m.drive_sheet_fmt_borders()}</option>
    {#each PRESETS as p (p)}<option value={p}>{presetLabel(p)}</option>{/each}
  </select>
  <select
    class="{field} w-28"
    bind:value={lineStyle}
    aria-label={m.drive_sheet_fmt_line_style()}
    data-testid="xlsx-border-style"
  >
    {#each LINE_STYLES as s (s)}<option value={s}>{lineLabel(s)}</option>{/each}
  </select>
  <label class="{btn} relative cursor-pointer" title={m.drive_sheet_fmt_line_color()}>
    <span
      class="size-4 rounded-sm border border-border"
      style="background-color: {lineColor ?? 'var(--foreground)'}"
      aria-hidden="true"
    ></span>
    <input
      type="color"
      class="sr-only"
      value={lineColor ?? '#000000'}
      aria-label={m.drive_sheet_fmt_line_color()}
      onchange={(e) => (lineColor = e.currentTarget.value.toUpperCase())}
      data-testid="xlsx-border-color"
    />
  </label>
  <span class={sep} aria-hidden="true"></span>
  <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
    <span>{m.drive_sheet_fmt_col_width()}</span>
    <input
      type="number"
      class="{field} w-20"
      min="0.1"
      max="255"
      step="0.01"
      value={round2(width)}
      onchange={(e) => {
        const v = sizeIn(e.currentTarget.value, 255)
        if (v === undefined) e.currentTarget.value = String(round2(width))
        else onwidth(v)
      }}
      data-testid="xlsx-col-width"
    />
  </label>
  <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
    <span>{m.drive_sheet_fmt_row_height()}</span>
    <input
      type="number"
      class="{field} w-20"
      min="0.25"
      max="409"
      step="0.25"
      value={round2(height)}
      onchange={(e) => {
        const v = sizeIn(e.currentTarget.value, 409)
        if (v === undefined) e.currentTarget.value = String(round2(height))
        else onheight(v)
      }}
      data-testid="xlsx-row-height"
    />
  </label>
</div>
