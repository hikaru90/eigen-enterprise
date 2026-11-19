<script lang="ts">
  import type { AssistantAttachmentKind } from './attachments'
  import FileText from '@lucide/svelte/icons/file-text'
  import Image from '@lucide/svelte/icons/image'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import X from '@lucide/svelte/icons/x'
  import { formatAttachmentSize } from './attachments'

  /**
   * One attached file as a chip: in the composer (reading… / ready, removable) and on the
   * sent message. Name and size only — the text it carried went to the model.
   */
  let {
    name,
    sizeBytes,
    kind = null,
    reading = false,
    tone = 'plain',
    onremove,
    testid,
  }: {
    name: string
    sizeBytes: number
    /** null while the file is still being read. */
    kind?: AssistantAttachmentKind | null
    reading?: boolean
    /** 'user': on the member's own (primary-coloured) message bubble. */
    tone?: 'plain' | 'user'
    onremove?: () => void
    testid: string
  } = $props()
</script>

<li
  class={[
    'inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-sm border py-1 pr-1.5 pl-2 text-xs',
    tone === 'user'
      ? 'border-primary-foreground/30 bg-primary-foreground/10 text-primary-foreground'
      : 'border-border bg-muted/50 text-foreground',
  ]}
  data-testid={testid}
>
  {#if reading}
    <LoaderCircle class="size-3.5 shrink-0 animate-spin" strokeWidth={1.75} aria-label="Reading" />
  {:else if kind === 'image'}
    <Image class="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
  {:else}
    <FileText class="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
  {/if}
  <span class="min-w-0 truncate" title={name}>{name}</span>
  <span class={tone === 'user' ? 'shrink-0 opacity-75' : 'shrink-0 text-muted-foreground'}>
    {reading ? 'Reading…' : formatAttachmentSize(sizeBytes)}
  </span>
  {#if onremove}
    <button
      type="button"
      class="grid size-5 shrink-0 cursor-pointer place-items-center rounded-sm text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"
      aria-label={`Remove ${name}`}
      title={`Remove ${name}`}
      onclick={onremove}
    >
      <X class="size-3.5" strokeWidth={1.75} aria-hidden="true" />
    </button>
  {/if}
</li>
