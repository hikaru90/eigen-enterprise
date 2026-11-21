<script lang="ts">
  import type { DocxEditorView } from './edit/editor'
  import type { Reviewer } from './edit/review'
  import type { DocxEditSession } from './edit/session'
  import type { EditorState } from 'prosemirror-state'
  import CheckIcon from '@lucide/svelte/icons/check'
  import CheckCheckIcon from '@lucide/svelte/icons/check-check'
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down'
  import ChevronUpIcon from '@lucide/svelte/icons/chevron-up'
  import FileDiffIcon from '@lucide/svelte/icons/file-diff'
  import ListXIcon from '@lucide/svelte/icons/list-x'
  import XIcon from '@lucide/svelte/icons/x'
  import { Button } from '$lib/components/ui/button'
  import {
    changeAt,
    decideAll,
    decideChange,
    gotoChange,
    setTracking,
    trackedChanges,
  } from './edit/review'

  /**
   * Review in the Edit layout: Track changes on or off (saved in the file,
   * settings.xml), step through the tracked changes, accept or reject the
   * one under the cursor or all of them. Tracking needs to know who is
   * editing (`reviewer`); without it the switch stays off and says why.
   */
  let {
    session,
    editor,
    pmState,
    reviewer,
    disabled,
  }: {
    session: DocxEditSession
    editor: DocxEditorView
    pmState: EditorState
    reviewer: Reviewer | null
    disabled: boolean
  } = $props()

  const tracking = $derived(pmState.doc.attrs.trackRevisions as boolean)
  const changes = $derived(trackedChanges(pmState.doc))
  const current = $derived(changeAt(pmState, changes))
  const index = $derived(current ? changes.indexOf(current) + 1 : 0)
  const WHAT = {
    insert: 'Insertion',
    delete: 'Deletion',
    format: 'Formatting',
    paragraph: 'Paragraph formatting',
    'mark-insert': 'New paragraph',
    'mark-delete': 'Joined paragraphs',
  } as const
  const describe = $derived(
    current
      ? `${current.move ? (current.kind === 'insert' ? 'Moved here' : 'Moved away') : WHAT[current.kind]} by ${current.author ?? 'an unknown author'}`
      : null,
  )
</script>

<div
  class="flex flex-wrap items-center gap-1 border-b bg-muted/10 px-2 py-1 text-xs"
  role="toolbar"
  aria-label="Review"
  data-testid="docx-review-bar"
>
  <Button
    variant={tracking ? 'secondary' : 'ghost'}
    size="sm"
    class="h-7 text-xs"
    aria-pressed={tracking}
    disabled={disabled || !reviewer}
    onclick={() => editor.run(setTracking(!tracking))}
    title={reviewer
      ? 'Record edits as tracked changes'
      : 'Your name isn’t known here, so changes can’t be tracked'}
    data-testid="docx-track-toggle"
  >
    <FileDiffIcon />Track changes
  </Button>
  {#if !reviewer}
    <span class="text-destructive" data-testid="docx-track-off">
      {tracking
        ? 'This document tracks changes, but your name isn’t known here, so it can’t take edits.'
        : 'Your name isn’t known here, so changes can’t be tracked.'}
    </span>
  {/if}
  <span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
  <span
    class="tabular-nums text-muted-foreground"
    data-testid="docx-change-count"
    aria-live="polite"
  >
    {changes.length === 0
      ? 'No tracked changes'
      : current
        ? `Change ${index} of ${changes.length}`
        : `${changes.length} tracked ${changes.length === 1 ? 'change' : 'changes'}`}
  </span>
  <Button
    variant="ghost"
    size="icon-sm"
    aria-label="Previous change"
    disabled={changes.length === 0}
    onclick={() => editor.run(gotoChange(-1))}><ChevronUpIcon /></Button
  >
  <Button
    variant="ghost"
    size="icon-sm"
    aria-label="Next change"
    disabled={changes.length === 0}
    onclick={() => editor.run(gotoChange(1))}><ChevronDownIcon /></Button
  >
  {#if describe}<span class="text-muted-foreground" data-testid="docx-change-current"
      >{describe}</span
    >{/if}
  <Button
    variant="ghost"
    size="sm"
    class="h-7 text-xs"
    disabled={disabled || !current}
    onclick={() => current && editor.run(decideChange(session, current, true))}
    data-testid="docx-change-accept"><CheckIcon />Accept</Button
  >
  <Button
    variant="ghost"
    size="sm"
    class="h-7 text-xs"
    disabled={disabled || !current}
    onclick={() => current && editor.run(decideChange(session, current, false))}
    data-testid="docx-change-reject"><XIcon />Reject</Button
  >
  <Button
    variant="ghost"
    size="sm"
    class="h-7 text-xs"
    disabled={disabled || changes.length === 0}
    onclick={() => editor.run(decideAll(session, true))}
    data-testid="docx-change-accept-all"><CheckCheckIcon />Accept all</Button
  >
  <Button
    variant="ghost"
    size="sm"
    class="h-7 text-xs"
    disabled={disabled || changes.length === 0}
    onclick={() => editor.run(decideAll(session, false))}
    data-testid="docx-change-reject-all"><ListXIcon />Reject all</Button
  >
</div>
