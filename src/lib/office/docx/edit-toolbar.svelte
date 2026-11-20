<script lang="ts">
  import type { DocxEditorView } from './edit/editor'
  import type { DocxEditSession } from './edit/session'
  import type { EditorState } from 'prosemirror-state'
  import BaselineIcon from '@lucide/svelte/icons/baseline'
  import BetweenHorizontalEndIcon from '@lucide/svelte/icons/between-horizontal-end'
  import BetweenVerticalEndIcon from '@lucide/svelte/icons/between-vertical-end'
  import BoldIcon from '@lucide/svelte/icons/bold'
  import HighlighterIcon from '@lucide/svelte/icons/highlighter'
  import ImageIcon from '@lucide/svelte/icons/image'
  import ItalicIcon from '@lucide/svelte/icons/italic'
  import LinkIcon from '@lucide/svelte/icons/link'
  import ListIcon from '@lucide/svelte/icons/list'
  import ListIndentDecreaseIcon from '@lucide/svelte/icons/list-indent-decrease'
  import ListIndentIncreaseIcon from '@lucide/svelte/icons/list-indent-increase'
  import ListOrderedIcon from '@lucide/svelte/icons/list-ordered'
  import Redo2Icon from '@lucide/svelte/icons/redo-2'
  import RemoveFormattingIcon from '@lucide/svelte/icons/remove-formatting'
  import StrikethroughIcon from '@lucide/svelte/icons/strikethrough'
  import TableIcon from '@lucide/svelte/icons/table'
  import TextAlignCenterIcon from '@lucide/svelte/icons/text-align-center'
  import TextAlignEndIcon from '@lucide/svelte/icons/text-align-end'
  import TextAlignJustifyIcon from '@lucide/svelte/icons/text-align-justify'
  import TextAlignStartIcon from '@lucide/svelte/icons/text-align-start'
  import TrashIcon from '@lucide/svelte/icons/trash'
  import UnderlineIcon from '@lucide/svelte/icons/underline'
  import Undo2Icon from '@lucide/svelte/icons/undo-2'
  import { redo, redoDepth, undo, undoDepth } from 'prosemirror-history'
  import { Button } from '$lib/components/ui/button'
  import {
    activeMark,
    clearFormatting,
    indent,
    insertTable,
    listKindOf,
    markActive,
    setAlign,
    setFormat,
    setStyle,
    tableCommands,
    toggleFormat,
    toggleList,
  } from './edit/commands'
  import { resolvedParagraph, type ParagraphAttrs } from './edit/schema'
  import { HIGHLIGHT } from './render'
  import { wc } from './xml'

  /**
   * The Word editor's toolbar: paragraph style (the document's own styles),
   * character formatting, alignment, lists, links, tables, pictures,
   * undo/redo. `pmState` is the editor's state after every transaction; the
   * buttons reflect it.
   */
  let {
    session,
    editor,
    pmState,
    disabled,
    onlink,
    onimage,
  }: {
    session: DocxEditSession
    editor: DocxEditorView
    pmState: EditorState
    disabled: boolean
    onlink: () => void
    onimage: () => void
  } = $props()

  const marks = $derived(session.schema.marks)
  const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72]
  const HIGHLIGHTS = ['yellow', 'green', 'cyan', 'magenta', 'blue', 'red', 'darkBlue', 'darkCyan', 'darkGreen', 'darkMagenta', 'darkRed', 'darkYellow', 'darkGray', 'lightGray', 'black']

  /**
   * The paragraph styles to offer: those styles.xml marks for the style
   * gallery (w:qFormat, §17.7.4.14), else every paragraph style it doesn't
   * hide (w:semiHidden / w:hidden); the current one always.
   */
  const styleOptions = $derived.by(() => {
    const all = [...session.docx.styles.styles.values()].filter((s) => s.type === 'paragraph')
    const gallery = all.filter((s) => wc(s.source, 'qFormat'))
    const shown = gallery.length > 0 ? gallery : all.filter((s) => !wc(s.source, 'semiHidden') && !wc(s.source, 'hidden'))
    return shown.map((s) => ({ id: s.id, name: s.name ?? s.id }))
  })

  const para = $derived(pmState.selection.$from.parent.type.name === 'paragraph' ? (pmState.selection.$from.parent.attrs as ParagraphAttrs) : null)
  const resolved = $derived(para ? resolvedParagraph(session.display, para) : null)
  const styleId = $derived(para?.styleId ?? session.docx.styles.defaults.paragraph ?? '')
  const styleChoices = $derived(
    styleOptions.some((s) => s.id === styleId) || !styleId ? styleOptions : [...styleOptions, { id: styleId, name: session.docx.styles.styles.get(styleId)?.name ?? styleId }],
  )
  const sizePt = $derived.by(() => {
    const m = activeMark(pmState, marks.size!)
    return m ? (m.attrs.halfPoints as number) / 2 : (resolved?.runBase.sizePt ?? 10)
  })
  const color = $derived(`#${(activeMark(pmState, marks.color!)?.attrs.hex as string | undefined) ?? '000000'}`)
  const highlight = $derived((activeMark(pmState, marks.highlight!)?.attrs.val as string | undefined) ?? 'none')
  const align = $derived(resolved?.props.align ?? 'start')
  const listKind = $derived(para ? listKindOf(session, para) : null)
  const inTable = $derived(tableCommands.inTable(pmState))
  const canUndo = $derived(undoDepth(pmState) > 0)
  const canRedo = $derived(redoDepth(pmState) > 0)
  const on = (name: 'bold' | 'italic' | 'underline' | 'strike') => markActive(pmState, marks[name]!)

  const run = (cmd: Parameters<DocxEditorView['run']>[0]) => editor.run(cmd)
</script>

<div class="flex flex-wrap items-center gap-1 border-b bg-muted/20 px-2 py-1 text-sm" role="toolbar" aria-label="Formatting" data-testid="docx-edit-toolbar">
  <Button variant="ghost" size="icon-sm" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={disabled || !canUndo} onclick={() => run(undo)}><Undo2Icon /></Button>
  <Button variant="ghost" size="icon-sm" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={disabled || !canRedo} onclick={() => run(redo)}><Redo2Icon /></Button>
  <span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
  <select
    class="h-7 max-w-40 rounded-md border bg-background px-1.5 text-xs"
    aria-label="Paragraph style"
    data-testid="docx-style"
    {disabled}
    value={styleId}
    onchange={(e) => run(setStyle(e.currentTarget.value || null))}
  >
    {#each styleChoices as s (s.id)}
      <option value={s.id}>{s.name}</option>
    {/each}
  </select>
  <select
    class="h-7 w-16 rounded-md border bg-background px-1.5 text-xs tabular-nums"
    aria-label="Font size"
    data-testid="docx-size"
    {disabled}
    value={String(sizePt)}
    onchange={(e) => run(setFormat(marks.size!, { halfPoints: Math.round(Number(e.currentTarget.value) * 2) }))}
  >
    {#each SIZES.includes(sizePt) ? SIZES : [...SIZES, sizePt].sort((a, b) => a - b) as s (s)}
      <option value={String(s)}>{s}</option>
    {/each}
  </select>
  <span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
  <Button variant={on('bold') ? 'secondary' : 'ghost'} size="icon-sm" aria-label="Bold" title="Bold (Ctrl+B)" aria-pressed={on('bold')} {disabled} onclick={() => run(toggleFormat(marks.bold!))}><BoldIcon /></Button>
  <Button variant={on('italic') ? 'secondary' : 'ghost'} size="icon-sm" aria-label="Italic" title="Italic (Ctrl+I)" aria-pressed={on('italic')} {disabled} onclick={() => run(toggleFormat(marks.italic!))}><ItalicIcon /></Button>
  <Button variant={on('underline') ? 'secondary' : 'ghost'} size="icon-sm" aria-label="Underline" title="Underline (Ctrl+U)" aria-pressed={on('underline')} {disabled} onclick={() => run(toggleFormat(marks.underline!))}><UnderlineIcon /></Button>
  <Button variant={on('strike') ? 'secondary' : 'ghost'} size="icon-sm" aria-label="Strikethrough" title="Strikethrough" aria-pressed={on('strike')} {disabled} onclick={() => run(toggleFormat(marks.strike!))}><StrikethroughIcon /></Button>
  <label class="relative inline-flex size-7 cursor-pointer items-center justify-center rounded-md hover:bg-accent" title="Text colour">
    <BaselineIcon class="size-4" style="color:{color}" />
    <input
      type="color"
      class="absolute inset-0 cursor-pointer opacity-0"
      aria-label="Text colour"
      data-testid="docx-color"
      {disabled}
      value={color}
      onchange={(e) => run(setFormat(marks.color!, { hex: e.currentTarget.value.slice(1).toLowerCase() }))}
    />
  </label>
  <label class="inline-flex items-center gap-0.5" title="Highlight">
    <HighlighterIcon class="size-4 text-muted-foreground" />
    <select
      class="h-7 w-24 rounded-md border bg-background px-1 text-xs"
      aria-label="Highlight"
      data-testid="docx-highlight"
      {disabled}
      value={highlight}
      onchange={(e) => run(setFormat(marks.highlight!, e.currentTarget.value === 'none' ? null : { val: e.currentTarget.value }))}
    >
      <option value="none">None</option>
      {#each HIGHLIGHTS as h (h)}
        <option value={h} style="background:{HIGHLIGHT[h]}">{h}</option>
      {/each}
    </select>
  </label>
  <span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
  <Button variant={align === 'start' ? 'secondary' : 'ghost'} size="icon-sm" aria-label="Align left" title="Align left (Ctrl+L)" aria-pressed={align === 'start'} {disabled} onclick={() => run(setAlign('left'))}><TextAlignStartIcon /></Button>
  <Button variant={align === 'center' ? 'secondary' : 'ghost'} size="icon-sm" aria-label="Center" title="Center (Ctrl+E)" aria-pressed={align === 'center'} {disabled} onclick={() => run(setAlign('center'))}><TextAlignCenterIcon /></Button>
  <Button variant={align === 'end' ? 'secondary' : 'ghost'} size="icon-sm" aria-label="Align right" title="Align right (Ctrl+R)" aria-pressed={align === 'end'} {disabled} onclick={() => run(setAlign('right'))}><TextAlignEndIcon /></Button>
  <Button variant={align === 'justify' ? 'secondary' : 'ghost'} size="icon-sm" aria-label="Justify" title="Justify (Ctrl+J)" aria-pressed={align === 'justify'} {disabled} onclick={() => run(setAlign('both'))}><TextAlignJustifyIcon /></Button>
  <span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
  <Button variant={listKind === 'bullet' ? 'secondary' : 'ghost'} size="icon-sm" aria-label="Bulleted list" aria-pressed={listKind === 'bullet'} {disabled} onclick={() => run(toggleList(session, 'bullet'))}><ListIcon /></Button>
  <Button variant={listKind === 'number' ? 'secondary' : 'ghost'} size="icon-sm" aria-label="Numbered list" aria-pressed={listKind === 'number'} {disabled} onclick={() => run(toggleList(session, 'number'))}><ListOrderedIcon /></Button>
  <Button variant="ghost" size="icon-sm" aria-label="Decrease indent" title="Decrease indent (Shift+Tab in a list)" {disabled} onclick={() => run(indent(session, -1))}><ListIndentDecreaseIcon /></Button>
  <Button variant="ghost" size="icon-sm" aria-label="Increase indent" title="Increase indent (Tab in a list)" {disabled} onclick={() => run(indent(session, 1))}><ListIndentIncreaseIcon /></Button>
  <span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
  <Button variant="ghost" size="icon-sm" aria-label="Link" title="Link (Ctrl+K)" {disabled} onclick={onlink}><LinkIcon /></Button>
  <Button variant="ghost" size="icon-sm" aria-label="Insert picture" title="Insert a picture from your computer" {disabled} onclick={onimage}><ImageIcon /></Button>
  <Button variant="ghost" size="icon-sm" aria-label="Insert table" title="Insert a 3 × 3 table" {disabled} onclick={() => run(insertTable(session, 3, 3))}><TableIcon /></Button>
  {#if inTable}
    <Button variant="ghost" size="icon-sm" aria-label="Add row" title="Add a row below" {disabled} onclick={() => run(tableCommands.addRow)}><BetweenHorizontalEndIcon /></Button>
    <Button variant="ghost" size="icon-sm" aria-label="Add column" title="Add a column to the right" {disabled} onclick={() => run(tableCommands.addColumn)}><BetweenVerticalEndIcon /></Button>
    <Button variant="ghost" size="sm" class="h-7 px-1.5 text-xs" aria-label="Delete row" {disabled} onclick={() => run(tableCommands.deleteRow)}><TrashIcon />Row</Button>
    <Button variant="ghost" size="sm" class="h-7 px-1.5 text-xs" aria-label="Delete column" {disabled} onclick={() => run(tableCommands.deleteColumn)}><TrashIcon />Column</Button>
  {/if}
  <span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
  <Button variant="ghost" size="icon-sm" aria-label="Clear formatting" title="Clear formatting" {disabled} onclick={() => run(clearFormatting)}><RemoveFormattingIcon /></Button>
</div>
