<script lang="ts">
  import type { ReplyQuote } from './quote'
  import ImageIcon from '@lucide/svelte/icons/image'
  import Mic from '@lucide/svelte/icons/mic'
  import Paperclip from '@lucide/svelte/icons/paperclip'
  import Phone from '@lucide/svelte/icons/phone'
  import X from '@lucide/svelte/icons/x'

  /**
   * A quoted original (Contribute 2a58bcc8, WhatsApp-style "Reply"): a thin
   * accent bar, the author and the first line (or the file marker). Above a
   * reply it is a button that jumps to the original; in the composer it reads
   * "Replying to …" with a dismiss button.
   */
  let {
    quote,
    composer = false,
    onopen,
    ondismiss,
  }: {
    quote: ReplyQuote
    /** The composer's preview (dismissible) instead of the quote above a sent reply. */
    composer?: boolean
    onopen?: () => void
    ondismiss?: () => void
  } = $props()

  const fileText = $derived(
    quote.attachment ? (quote.attachment.count > 1 ? `${quote.attachment.label} +${quote.attachment.count - 1}` : quote.attachment.label) : '',
  )
  const label = $derived(
    quote.deleted ? 'Original message deleted' : `${quote.authorName}: ${quote.snippet || fileText || (quote.call ? 'Call' : '')}`,
  )
</script>

{#snippet content()}
  <span class="h-auto w-0.5 shrink-0 self-stretch rounded-full bg-primary/60" aria-hidden="true"></span>
  <span class="min-w-0 flex-1">
    {#if quote.deleted}
      <span class="block text-xs leading-5 text-muted-foreground italic" data-testid="reply-quote-deleted">Original message deleted</span>
    {:else}
      <span class="block truncate text-xs leading-5 font-semibold text-foreground" data-testid="reply-quote-author"
        >{composer ? `Replying to ${quote.authorName}` : quote.authorName}</span
      >
      <span class="flex min-w-0 items-center gap-1 text-xs leading-5 text-muted-foreground">
        {#if quote.attachment}
          <span class="inline-flex shrink-0 items-center gap-1" data-testid="reply-quote-file" data-kind={quote.attachment.kind}>
            {#if quote.attachment.kind === 'voice'}<Mic class="size-3.5" aria-hidden="true" />{:else if quote.attachment.kind === 'image'}<ImageIcon
                class="size-3.5"
                aria-hidden="true"
              />{:else}<Paperclip class="size-3.5" aria-hidden="true" />{/if}
            {#if !quote.snippet}<span class="truncate">{fileText}</span>{/if}
          </span>
        {:else if quote.call}
          <Phone class="size-3.5 shrink-0" aria-hidden="true" /><span>Call</span>
        {/if}
        {#if quote.snippet}<span class="truncate" data-testid="reply-quote-snippet">{quote.snippet}</span>{/if}
      </span>
    {/if}
  </span>
{/snippet}

{#if composer}
  <div class="mx-3 mt-2.5 flex items-stretch gap-2 rounded-lg bg-foreground/[0.04] py-1.5 pr-1 pl-2" data-testid="reply-preview">
    {@render content()}
    <button
      type="button"
      class="grid size-6 shrink-0 place-items-center self-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
      aria-label="Cancel reply"
      title="Cancel reply (Esc)"
      data-testid="reply-preview-cancel"
      onclick={() => ondismiss?.()}><X class="size-3.5" /></button
    >
  </div>
{:else}
  <button
    type="button"
    class="mt-0.5 mb-1 flex w-full max-w-md min-w-0 items-stretch gap-2 rounded-lg bg-foreground/[0.04] py-1 pr-2 pl-2 text-left hover:bg-foreground/[0.07] disabled:cursor-default disabled:hover:bg-foreground/[0.04]"
    aria-label={quote.deleted ? label : `Show the original message — ${label}`}
    disabled={quote.deleted}
    data-testid="reply-quote"
    data-reply-to={quote.id}
    onclick={() => onopen?.()}
  >
    {@render content()}
  </button>
{/if}
