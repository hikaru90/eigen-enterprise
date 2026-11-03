<script lang="ts">
  import BoldIcon from '@lucide/svelte/icons/bold'
  import CodeIcon from '@lucide/svelte/icons/code'
  import Heading1Icon from '@lucide/svelte/icons/heading-1'
  import Heading2Icon from '@lucide/svelte/icons/heading-2'
  import Heading3Icon from '@lucide/svelte/icons/heading-3'
  import ItalicIcon from '@lucide/svelte/icons/italic'
  import LinkIcon from '@lucide/svelte/icons/link'
  import ListIcon from '@lucide/svelte/icons/list'
  import ListChecksIcon from '@lucide/svelte/icons/list-checks'
  import ListOrderedIcon from '@lucide/svelte/icons/list-ordered'
  import PilcrowIcon from '@lucide/svelte/icons/pilcrow'
  import QuoteIcon from '@lucide/svelte/icons/quote'
  import Redo2Icon from '@lucide/svelte/icons/redo-2'
  import SquareCodeIcon from '@lucide/svelte/icons/square-code'
  import StrikethroughIcon from '@lucide/svelte/icons/strikethrough'
  import TableIcon from '@lucide/svelte/icons/table'
  import Undo2Icon from '@lucide/svelte/icons/undo-2'
  import { onMount, untrack } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import {
    createMarkdownEditor,
    type MarkdownAction,
    type MarkdownEditorHandle,
  } from '$lib/drive/markdown-editor'

  /**
   * WYSIWYG Markdown (Milkdown): the toolbar, Milkdown's own shortcuts
   * (Mod-B/I, Mod-Alt-1…3 headings, Mod-Z/Shift-Z, Markdown input rules like
   * "# " and "- [ ] ") plus Mod-K for links. `onchange` gets the new
   * Markdown whenever it differs from what was loaded.
   */
  let {
    content,
    editable,
    onchange,
  }: { content: string; editable: boolean; onchange?: (markdown: string) => void } = $props()

  let root: HTMLDivElement
  let handle: MarkdownEditorHandle | null = null
  let failed = $state<string | null>(null)
  let linkOpen = $state(false)
  let linkHref = $state('')
  let isEditable = $state(untrack(() => editable))
  /** A load() that arrived before the editor finished starting. */
  let pendingLoad: string | null = null

  onMount(() => {
    let disposed = false
    createMarkdownEditor(root, content, {
      editable: isEditable,
      onChange: (md) => onchange?.(md),
    }).then(
      (h) => {
        if (disposed) return void h.destroy()
        handle = h
        h.setEditable(isEditable)
        if (pendingLoad !== null) h.load(pendingLoad)
        pendingLoad = null
      },
      (err) => (failed = err instanceof Error ? err.message : String(err)),
    )
    return () => {
      disposed = true
      void handle?.destroy()
      handle = null
    }
  })

  /** Replaces the document (restore, takeover). */
  export function load(markdown: string) {
    if (handle) handle.load(markdown)
    else pendingLoad = markdown
  }
  export function setEditable(next: boolean) {
    isEditable = next
    handle?.setEditable(next)
  }
  export function markdown(): string | null {
    return handle?.markdown() ?? null
  }

  function run(action: MarkdownAction) {
    handle?.run(action)
    handle?.focus()
  }

  function openLink() {
    linkHref = ''
    linkOpen = true
  }
  function applyLink(event: SubmitEvent) {
    event.preventDefault()
    handle?.link(linkHref.trim())
    linkOpen = false
    handle?.focus()
  }

  function onkeydown(event: KeyboardEvent) {
    if (isEditable && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      openLink()
    }
  }

  const tools: Array<
    { action: MarkdownAction; label: string; icon: typeof BoldIcon; keys?: string } | 'sep'
  > = [
    { action: 'paragraph', label: 'Text', icon: PilcrowIcon, keys: 'Mod-Alt-0' },
    { action: 'h1', label: 'Heading 1', icon: Heading1Icon, keys: 'Mod-Alt-1' },
    { action: 'h2', label: 'Heading 2', icon: Heading2Icon, keys: 'Mod-Alt-2' },
    { action: 'h3', label: 'Heading 3', icon: Heading3Icon, keys: 'Mod-Alt-3' },
    'sep',
    { action: 'bold', label: 'Bold', icon: BoldIcon, keys: 'Mod-B' },
    { action: 'italic', label: 'Italic', icon: ItalicIcon, keys: 'Mod-I' },
    { action: 'strike', label: 'Strikethrough', icon: StrikethroughIcon, keys: 'Mod-Alt-X' },
    { action: 'code', label: 'Inline code', icon: CodeIcon, keys: 'Mod-E' },
    'sep',
    { action: 'bullet', label: 'Bulleted list', icon: ListIcon, keys: 'Mod-Alt-8' },
    { action: 'ordered', label: 'Numbered list', icon: ListOrderedIcon, keys: 'Mod-Alt-7' },
    { action: 'task', label: 'Task list', icon: ListChecksIcon },
    { action: 'quote', label: 'Quote', icon: QuoteIcon, keys: 'Mod-Shift-B' },
    { action: 'codeblock', label: 'Code block', icon: SquareCodeIcon, keys: 'Mod-Alt-C' },
    { action: 'table', label: 'Table', icon: TableIcon },
    'sep',
    { action: 'undo', label: 'Undo', icon: Undo2Icon, keys: 'Mod-Z' },
    { action: 'redo', label: 'Redo', icon: Redo2Icon, keys: 'Mod-Shift-Z' },
  ]
</script>

<!-- Mod-K (link) is handled for the whole editor here; the keys reach it from the toolbar and the editable area inside. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="flex flex-col" role="group" aria-label="Markdown editor" {onkeydown} data-testid="drive-md">
  {#if isEditable}
    <div
      class="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 border-b bg-background/95 px-2 py-1 backdrop-blur"
      role="toolbar"
      aria-label="Formatting"
      data-testid="drive-md-toolbar"
    >
      {#each tools as tool, i (i)}
        {#if tool === 'sep'}
          <span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
        {:else}
          {@const Icon = tool.icon}
          <Button
            size="icon"
            variant="ghost"
            class="size-8"
            title={tool.keys ? `${tool.label} (${tool.keys.replace('Mod', 'Ctrl/⌘')})` : tool.label}
            aria-label={tool.label}
            onmousedown={(e: MouseEvent) => e.preventDefault()}
            onclick={() => run(tool.action)}
            data-testid={`drive-md-${tool.action}`}><Icon class="size-4" /></Button
          >
        {/if}
      {/each}
      <Button
        size="icon"
        variant="ghost"
        class="size-8"
        title="Link (Ctrl/⌘-K)"
        aria-label="Link"
        onmousedown={(e: MouseEvent) => e.preventDefault()}
        onclick={openLink}
        data-testid="drive-md-link"><LinkIcon class="size-4" /></Button
      >
    </div>
    {#if linkOpen}
      <form
        class="flex items-center gap-2 border-b px-3 py-2"
        onsubmit={applyLink}
        data-testid="drive-md-link-form"
      >
        <Input
          class="h-8 max-w-md"
          placeholder="https://… (empty removes the link)"
          bind:value={linkHref}
          autofocus
          data-testid="drive-md-link-input"
        />
        <Button size="sm" type="submit">Apply</Button>
        <Button size="sm" variant="ghost" type="button" onclick={() => (linkOpen = false)}
          >Cancel</Button
        >
      </form>
    {/if}
  {/if}
  {#if failed}<p class="px-6 py-4 text-sm text-destructive" role="alert">
      The editor could not start: {failed}
    </p>{/if}
  <div
    bind:this={root}
    class="drive-markdown max-w-3xl px-6 py-5 text-sm leading-relaxed"
    data-testid="drive-markdown"
  ></div>
</div>

<style>
  .drive-markdown :global(.drive-md-editor) {
    outline: none;
    min-height: 12rem;
    white-space: pre-wrap;
  }
  .drive-markdown :global(h1) {
    font-size: 1.5rem;
    font-weight: 600;
    margin: 0.25rem 0 0.75rem;
  }
  .drive-markdown :global(h2) {
    font-size: 1.25rem;
    font-weight: 600;
    margin: 1.25rem 0 0.5rem;
  }
  .drive-markdown :global(h3) {
    font-size: 1.05rem;
    font-weight: 600;
    margin: 1rem 0 0.5rem;
  }
  .drive-markdown :global(p) {
    margin: 0.5rem 0;
  }
  .drive-markdown :global(ul) {
    list-style: disc;
    padding-left: 1.5rem;
    margin: 0.5rem 0;
  }
  .drive-markdown :global(ol) {
    list-style: decimal;
    padding-left: 1.5rem;
    margin: 0.5rem 0;
  }
  .drive-markdown :global(li[data-item-type='task']) {
    list-style: none;
    position: relative;
  }
  .drive-markdown :global(li[data-item-type='task']::before) {
    content: '';
    position: absolute;
    left: -1.35rem;
    top: 0.3rem;
    width: 0.85rem;
    height: 0.85rem;
    border: 1.5px solid var(--muted-foreground);
    border-radius: 0.2rem;
  }
  .drive-markdown :global(li[data-item-type='task'][data-checked='true']::before) {
    background: var(--primary);
    border-color: var(--primary);
  }
  .drive-markdown :global(li[data-item-type='task'][data-checked='true']) {
    color: var(--muted-foreground);
    text-decoration: line-through;
  }
  .drive-markdown :global(a) {
    text-decoration: underline;
    color: var(--primary);
  }
  .drive-markdown :global(strong) {
    font-weight: 600;
  }
  .drive-markdown :global(code) {
    font-family: ui-monospace, monospace;
    font-size: 0.85em;
    background: var(--muted);
    padding: 0.1rem 0.3rem;
    border-radius: 0.25rem;
  }
  .drive-markdown :global(pre) {
    background: var(--muted);
    padding: 0.75rem;
    border-radius: 0.375rem;
    overflow-x: auto;
  }
  .drive-markdown :global(pre code) {
    background: none;
    padding: 0;
  }
  .drive-markdown :global(blockquote) {
    border-left: 3px solid var(--border);
    padding-left: 0.75rem;
    color: var(--muted-foreground);
  }
  .drive-markdown :global(table) {
    border-collapse: collapse;
    margin: 0.75rem 0;
  }
  .drive-markdown :global(th),
  .drive-markdown :global(td) {
    border: 1px solid var(--border);
    padding: 0.25rem 0.5rem;
    text-align: left;
    min-width: 4rem;
  }
  .drive-markdown :global(hr) {
    border-color: var(--border);
    margin: 1rem 0;
  }
  .drive-markdown :global(img) {
    max-width: 100%;
  }
</style>
