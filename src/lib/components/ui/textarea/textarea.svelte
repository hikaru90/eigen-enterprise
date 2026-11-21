<script lang="ts">
  import type { HTMLTextareaAttributes } from 'svelte/elements'
  import { page } from '$app/state'
  import { cn, type WithElementRef, type WithoutChildren } from '$lib/utils.js'
  import DictationField from '$lib/voice/dictation-field.svelte'

  let {
    ref = $bindable(null),
    value = $bindable(),
    class: className,
    'data-slot': dataSlot = 'textarea',
    dictation = true,
    containerClass,
    ...restProps
  }: WithoutChildren<WithElementRef<HTMLTextareaAttributes>> & {
    /**
     * Voice input (plan/shared-memory-voice-agent-tools.md §2): the dictation mic in the
     * bottom-right corner. `false` opts this field out (source code, data to paste);
     * read-only fields never get it.
     */
    dictation?: boolean
    /** Classes for the wrapper a dictating field sits in (its `flex-1`, a fixed width). */
    containerClass?: string
  } = $props()

  const base =
    'border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 disabled:bg-input/50 dark:disabled:bg-input/80 rounded-md border bg-transparent px-3 py-2 text-base transition-colors focus-visible:ring-1 aria-invalid:ring-1 md:text-sm placeholder:text-muted-foreground flex field-sizing-content min-h-16 w-full outline-hidden disabled:cursor-not-allowed disabled:opacity-50'

  /** Dictation is a member's: only inside the signed-in app (the shell), never on sign-in or guest pages. */
  const dictates = $derived(dictation && page.data.shell != null && !restProps.readonly)
  const voiceTestid = $derived(`${restProps['data-testid'] ?? restProps.id ?? 'field'}-voice`)
</script>

{#if dictates}
  <DictationField field={ref} kind="textarea" disabled={!!restProps.disabled} testid={voiceTestid} class={containerClass}>
    <textarea
      bind:this={ref}
      data-slot={dataSlot}
      class={cn(base, className, 'pr-10')}
      bind:value
      {...restProps}></textarea>
  </DictationField>
{:else}
  <textarea
    bind:this={ref}
    data-slot={dataSlot}
    class={cn(base, className)}
    bind:value
    {...restProps}></textarea>
{/if}
