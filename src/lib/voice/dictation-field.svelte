<script lang="ts">
  import type { Snippet } from 'svelte'
  import { cn } from '$lib/utils.js'
  import { dictateInto, type DictationTarget } from './dictation-insert'
  import VoiceDictation from './voice-dictation.svelte'

  /**
   * The dictation control inside a text field (plan/shared-memory-voice-agent-tools.md §2):
   * wraps the field and docks the mic at its right edge (a textarea's bottom-right corner).
   * Tapping it records; while recording the voice bar covers the field's edge (discard, level,
   * timer, Done); Done transcribes and the words go in at the cursor — after what is typed
   * when the person never put the cursor in the field. Nothing is sent: the person edits,
   * then sends as always. The shared Input and Textarea use this; a custom composer with an
   * action row puts `VoiceDictation` in that row instead and writes with `dictateInto`.
   *
   * The field itself needs room for the mic: `pr-9` (input) / `pr-10` (textarea).
   */
  let {
    field,
    kind,
    disabled = false,
    testid,
    class: className = '',
    children,
  }: {
    /** The field the words go into (its `bind:this`). */
    field: DictationTarget | null
    kind: 'input' | 'textarea'
    disabled?: boolean
    /** Prefix for the control's `data-testid`s (`<testid>-mic`, …). */
    testid: string
    /** Classes for the wrapper (it takes the field's place in the layout: `flex-1`, a width). */
    class?: string
    children: Snippet
  } = $props()

  let active = $state(false)
  /** The person put the cursor in this field (focus is how a cursor gets there). */
  let placed = false

  function onfocusin(event: FocusEvent): void {
    if (event.target === field) placed = true
  }

  function ontranscript(text: string): void {
    if (!field) throw new Error('dictation: the transcript arrived after its field went away')
    dictateInto(field, text, placed)
    placed = true
  }

  /** The bar closed (discarded, dismissed, transcript in): typing goes on where it was. */
  function onclose(): void {
    field?.focus({ preventScroll: true })
  }

  const dock = $derived(
    kind === 'input'
      ? active
        ? 'absolute inset-0.5 flex items-center rounded-[5px] bg-background px-0.5'
        : 'absolute inset-y-0 right-0.5 flex items-center'
      : active
        ? 'absolute inset-x-1 bottom-1 flex items-center rounded-md bg-background px-0.5'
        : 'absolute right-1 bottom-1 flex items-center',
  )
</script>

<div class={cn('relative w-full min-w-0', className)} data-slot="dictation-field" {onfocusin}>
  {@render children()}
  <div class={dock} data-testid="{testid}-dock">
    <VoiceDictation bind:active size="compact" {disabled} {testid} {ontranscript} {onclose} />
  </div>
</div>
