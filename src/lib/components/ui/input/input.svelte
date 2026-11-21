<script lang="ts">
  import type { HTMLInputAttributes, HTMLInputTypeAttribute } from 'svelte/elements'
  import { page } from '$app/state'
  import { cn, type WithElementRef } from '$lib/utils.js'
  import DictationField from '$lib/voice/dictation-field.svelte'
  import { inputTakesDictation } from '$lib/voice/dictation-insert'

  type InputType = Exclude<HTMLInputTypeAttribute, 'file'>

  type Props = WithElementRef<
    Omit<HTMLInputAttributes, 'type'> &
      ({ type: 'file'; files?: FileList } | { type?: InputType; files?: undefined }) & {
        /**
         * Voice input (plan/shared-memory-voice-agent-tools.md §2): a free-text field gets
         * the dictation mic. `false` opts this field out (identifiers, filters, codes);
         * password, email, number, URL, phone, date/time, search, one-time-code and
         * read-only fields never get it.
         */
        dictation?: boolean
        /** Classes for the wrapper a dictating field sits in (its `flex-1`, a fixed width). */
        containerClass?: string
      },
    HTMLInputElement
  >

  let {
    ref = $bindable(null),
    value = $bindable(),
    type,
    files = $bindable(),
    class: className,
    'data-slot': dataSlot = 'input',
    dictation = true,
    containerClass,
    ...restProps
  }: Props = $props()

  const base =
    'dark:bg-input/30 border-input focus-visible:border-ring focus-visible:ring-ring aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 disabled:bg-input/50 dark:disabled:bg-input/80 h-8 rounded-md border bg-transparent px-3 py-1 text-base transition-colors file:h-6 file:text-xs file:font-medium focus-visible:ring-1 aria-invalid:ring-1 md:text-sm file:text-foreground placeholder:text-muted-foreground w-full min-w-0 outline-hidden file:inline-flex file:border-0 file:bg-transparent disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50'

  /** Dictation is a member's: only inside the signed-in app (the shell), never on sign-in or guest pages. */
  const dictates = $derived(
    dictation &&
      page.data.shell != null &&
      type !== 'file' &&
      inputTakesDictation({
        type,
        autocomplete: restProps.autocomplete,
        inputmode: restProps.inputmode,
        readonly: restProps.readonly,
      }),
  )
  const voiceTestid = $derived(`${restProps['data-testid'] ?? restProps.id ?? 'field'}-voice`)
</script>

{#if type === 'file'}
  <input
    bind:this={ref}
    data-slot={dataSlot}
    class={cn(base, className)}
    type="file"
    bind:files
    bind:value
    {...restProps}
  />
{:else if dictates}
  <DictationField field={ref} kind="input" disabled={!!restProps.disabled} testid={voiceTestid} class={containerClass}>
    <input
      bind:this={ref}
      data-slot={dataSlot}
      class={cn(base, className, 'pr-9')}
      {type}
      bind:value
      {...restProps}
    />
  </DictationField>
{:else}
  <input
    bind:this={ref}
    data-slot={dataSlot}
    class={cn(base, className)}
    {type}
    bind:value
    {...restProps}
  />
{/if}
