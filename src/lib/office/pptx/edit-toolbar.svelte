<script lang="ts">
  import type { Align, RunFormat } from './ops'
  import type { Component } from 'svelte'
  import BoldIcon from '@lucide/svelte/icons/bold'
  import BringToFrontIcon from '@lucide/svelte/icons/bring-to-front'
  import CopyIcon from '@lucide/svelte/icons/copy'
  import ImagePlusIcon from '@lucide/svelte/icons/image-plus'
  import ItalicIcon from '@lucide/svelte/icons/italic'
  import ListIcon from '@lucide/svelte/icons/list'
  import Redo2Icon from '@lucide/svelte/icons/redo-2'
  import SendToBackIcon from '@lucide/svelte/icons/send-to-back'
  import AlignCenterIcon from '@lucide/svelte/icons/text-align-center'
  import AlignEndIcon from '@lucide/svelte/icons/text-align-end'
  import AlignJustifyIcon from '@lucide/svelte/icons/text-align-justify'
  import AlignStartIcon from '@lucide/svelte/icons/text-align-start'
  import TrashIcon from '@lucide/svelte/icons/trash'
  import TypeIcon from '@lucide/svelte/icons/type'
  import UnderlineIcon from '@lucide/svelte/icons/underline'
  import Undo2Icon from '@lucide/svelte/icons/undo-2'
  import { Button } from '$lib/components/ui/button'

  /**
   * The slide editor's toolbar (S2): text formatting for the selected shapes
   * or the selected text, insert, arrange, duplicate/delete, undo/redo.
   * Buttons keep the focus where it is (typing stays in the text box).
   */
  export type ToolbarState = {
    bold: boolean
    italic: boolean
    underline: boolean
    /** Font size in points, or null when mixed. */
    size: number | null
    /** RRGGBB, or null when mixed. */
    color: string | null
    align: Align | null
    bullets: boolean
  }

  let {
    state: s,
    text,
    selection,
    canUndo,
    canRedo,
    onformat,
    onalign,
    onbullets,
    oninserttext,
    oninsertpicture,
    onarrange,
    onduplicate,
    ondelete,
    onundo,
    onredo,
  }: {
    state: ToolbarState
    /** Text can be formatted (a text shape is selected or being typed into). */
    text: boolean
    /** Something is selected (arrange, duplicate, delete). */
    selection: boolean
    canUndo: boolean
    canRedo: boolean
    onformat: (f: RunFormat) => void
    onalign: (a: Align) => void
    onbullets: (on: boolean) => void
    oninserttext: () => void
    oninsertpicture: (file: File) => void
    onarrange: (dir: 'forward' | 'backward') => void
    onduplicate: () => void
    ondelete: () => void
    onundo: () => void
    onredo: () => void
  } = $props()

  let fileInput = $state<HTMLInputElement | null>(null)

  const ALIGNS: Array<{ value: Align; label: string; icon: Component }> = [
    { value: 'l', label: 'Align left', icon: AlignStartIcon },
    { value: 'ctr', label: 'Centre', icon: AlignCenterIcon },
    { value: 'r', label: 'Align right', icon: AlignEndIcon },
    { value: 'just', label: 'Justify', icon: AlignJustifyIcon },
  ]

  function keepFocus(e: MouseEvent) {
    if (e.target instanceof Element && e.target.closest('button')) e.preventDefault()
  }

  function onSize(e: Event) {
    const v = Number((e.currentTarget as HTMLInputElement).value)
    if (Number.isFinite(v) && v >= 1 && v <= 4000) onformat({ size: Math.round(v * 100) })
  }

  function onPicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (file) oninsertpicture(file)
  }
</script>

<div class="flex flex-wrap items-center gap-1 border-b bg-muted/30 px-3 py-1.5" role="toolbar" aria-label="Slide editing" tabindex="-1" onmousedown={keepFocus} data-pptx-toolbar data-testid="pptx-toolbar">
  <Button variant="ghost" size="icon-sm" aria-label="Undo" title="Undo (⌘Z)" disabled={!canUndo} onclick={onundo} data-testid="pptx-undo"><Undo2Icon aria-hidden="true" /></Button>
  <Button variant="ghost" size="icon-sm" aria-label="Redo" title="Redo (⇧⌘Z)" disabled={!canRedo} onclick={onredo} data-testid="pptx-redo"><Redo2Icon aria-hidden="true" /></Button>
  <span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
  <Button variant={s.bold && text ? 'secondary' : 'ghost'} size="icon-sm" aria-label="Bold" aria-pressed={text ? s.bold : undefined} title="Bold" disabled={!text} onclick={() => onformat({ bold: !s.bold })} data-testid="pptx-bold"><BoldIcon aria-hidden="true" /></Button>
  <Button variant={s.italic && text ? 'secondary' : 'ghost'} size="icon-sm" aria-label="Italic" aria-pressed={text ? s.italic : undefined} title="Italic" disabled={!text} onclick={() => onformat({ italic: !s.italic })} data-testid="pptx-italic"><ItalicIcon aria-hidden="true" /></Button>
  <Button variant={s.underline && text ? 'secondary' : 'ghost'} size="icon-sm" aria-label="Underline" aria-pressed={text ? s.underline : undefined} title="Underline" disabled={!text} onclick={() => onformat({ underline: !s.underline })} data-testid="pptx-underline"><UnderlineIcon aria-hidden="true" /></Button>
  <label class="flex items-center gap-1 text-xs text-muted-foreground">
    <span class="sr-only">Font size (pt)</span>
    <input
      type="number"
      min="1"
      max="4000"
      step="1"
      class="h-7 w-14 rounded-md border bg-background px-1.5 text-xs text-foreground tabular-nums disabled:opacity-50"
      value={text && s.size !== null ? s.size : ''}
      placeholder="pt"
      disabled={!text}
      onchange={onSize}
      title="Font size (pt)"
      data-testid="pptx-size"
    />
  </label>
  <label class="flex items-center" title="Text colour">
    <span class="sr-only">Text colour</span>
    <input type="color" class="h-7 w-8 cursor-pointer rounded-md border bg-background p-0.5 disabled:opacity-50" value={`#${s.color ?? '000000'}`} disabled={!text} onchange={(e) => onformat({ color: (e.currentTarget as HTMLInputElement).value.slice(1) })} data-testid="pptx-color" />
  </label>
  <span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
  {#each ALIGNS as al (al.value)}
    <Button variant={s.align === al.value && text ? 'secondary' : 'ghost'} size="icon-sm" aria-label={al.label} aria-pressed={text ? s.align === al.value : undefined} title={al.label} disabled={!text} onclick={() => onalign(al.value)} data-testid={`pptx-align-${al.value}`}>
      <al.icon aria-hidden="true" />
    </Button>
  {/each}
  <Button variant={s.bullets && text ? 'secondary' : 'ghost'} size="icon-sm" aria-label="Bullets" aria-pressed={text ? s.bullets : undefined} title="Bullets" disabled={!text} onclick={() => onbullets(!s.bullets)} data-testid="pptx-bullets"><ListIcon aria-hidden="true" /></Button>
  <span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
  <Button variant="ghost" size="sm" title="Insert a text box" onclick={oninserttext} data-testid="pptx-insert-text"><TypeIcon aria-hidden="true" /> Text box</Button>
  <Button variant="ghost" size="sm" title="Insert a picture from your computer" onclick={() => fileInput?.click()} data-testid="pptx-insert-picture"><ImagePlusIcon aria-hidden="true" /> Picture</Button>
  <input bind:this={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/bmp" class="hidden" onchange={onPicked} data-testid="pptx-picture-input" />
  <span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
  <Button variant="ghost" size="icon-sm" aria-label="Bring forward" title="Bring forward" disabled={!selection} onclick={() => onarrange('forward')} data-testid="pptx-forward"><BringToFrontIcon aria-hidden="true" /></Button>
  <Button variant="ghost" size="icon-sm" aria-label="Send backward" title="Send backward" disabled={!selection} onclick={() => onarrange('backward')} data-testid="pptx-backward"><SendToBackIcon aria-hidden="true" /></Button>
  <Button variant="ghost" size="icon-sm" aria-label="Duplicate" title="Duplicate (⌘D)" disabled={!selection} onclick={onduplicate} data-testid="pptx-duplicate"><CopyIcon aria-hidden="true" /></Button>
  <Button variant="ghost" size="icon-sm" aria-label="Delete" title="Delete (Del)" disabled={!selection} onclick={ondelete} data-testid="pptx-delete"><TrashIcon aria-hidden="true" /></Button>
</div>
