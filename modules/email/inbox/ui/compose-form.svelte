<script lang="ts">
  import type { ComposeDraft } from '../send'
  import type { SubmitFunction } from '@sveltejs/kit'
  import Paperclip from '@lucide/svelte/icons/paperclip'
  import { onMount, tick } from 'svelte'
  import { enhance } from '$app/forms'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import { fileSize } from './display'

  /**
   * The compose form (S5): new mail, reply, reply all, forward. A plain
   * multipart POST to ?/send with `use:enhance` (`submit` is the page's
   * callback). Fields are this component's own state, so nothing typed is lost
   * when a send fails or the page reloads its data while you write.
   */
  let {
    draft,
    submit,
    discardHref,
    busy = false,
    error = null,
  }: {
    draft: ComposeDraft
    submit: SubmitFunction
    discardHref: string
    busy?: boolean
    error?: string | null
  } = $props()

  const TITLES = { new: 'New mail', reply: 'Reply', replyAll: 'Reply all', forward: 'Forward' } as const

  // The form starts from the draft once; later reloads of the page's data never overwrite what was typed.
  // svelte-ignore state_referenced_locally
  const start = draft
  let from = $state(start.fromMailboxId ?? '')
  let to = $state(start.to)
  let cc = $state(start.cc)
  let bcc = $state('')
  let showBcc = $state(false)
  let subject = $state(start.subject)
  let body = $state(start.body)

  let toInput: HTMLInputElement | null = $state(null)
  let bodyInput: HTMLTextAreaElement | null = $state(null)
  let bccInput: HTMLInputElement | null = $state(null)

  const fromLabel = (c: ComposeDraft['fromChoices'][number]) => (c.name ? `${c.name} <${c.address}>` : c.address)
  const fixedFrom = $derived(draft.fromChoices.find((c) => c.id === from) ?? null)

  async function revealBcc() {
    showBcc = true
    await tick()
    bccInput?.focus()
  }

  onMount(() => {
    // A reply starts above the quoted text; new mail and forwards start at To.
    if (start.mode === 'reply' || start.mode === 'replyAll') {
      bodyInput?.focus()
      bodyInput?.setSelectionRange(0, 0)
      if (bodyInput) bodyInput.scrollTop = 0
    } else toInput?.focus()
  })

  const fieldClass = 'grid gap-1 sm:grid-cols-[4.5rem_minmax(0,1fr)] sm:items-center sm:gap-3'
  const labelClass = 'text-[13px] text-muted-foreground'
</script>

<section class="flex min-w-0 flex-col" aria-labelledby="compose-heading" data-testid="compose" data-mode={draft.mode}>
  <form
    method="POST"
    action="?/send"
    enctype="multipart/form-data"
    use:enhance={submit}
    class="flex flex-col gap-3 px-4 py-4"
    aria-busy={busy}
  >
    <h3 id="compose-heading" class="text-base font-semibold tracking-tight">{TITLES[draft.mode]}</h3>

    {#if draft.blocked}
      <p class="text-sm text-destructive" role="alert" data-testid="compose-blocked">{draft.blocked}</p>
    {/if}
    {#if error}
      <p class="text-sm text-destructive" role="alert" data-testid="compose-error">{error}</p>
    {/if}

    <input type="hidden" name="mode" value={draft.mode} />
    <input type="hidden" name="parentId" value={draft.parentId ?? ''} />

    <div class={fieldClass}>
      <label for="compose-from" class={labelClass}>From</label>
      {#if draft.mode === 'new' && draft.fromChoices.length > 1}
        <select
          id="compose-from"
          name="mailboxId"
          bind:value={from}
          class="h-8 min-w-0 rounded-md border border-input bg-background px-2.5 text-sm"
          data-testid="compose-from"
        >
          {#each draft.fromChoices as c (c.id)}
            <option value={c.id}>{fromLabel(c)}</option>
          {/each}
        </select>
      {:else}
        <input type="hidden" name="mailboxId" value={from} />
        <output id="compose-from" class="truncate text-sm" data-testid="compose-from">{fixedFrom ? fromLabel(fixedFrom) : '—'}</output>
      {/if}
    </div>

    <div class={fieldClass}>
      <label for="compose-to" class={labelClass}>To</label>
      <Input id="compose-to" name="to" bind:ref={toInput} bind:value={to} autocomplete="off" class="h-8" data-testid="compose-to" />
    </div>
    <div class={fieldClass}>
      <label for="compose-cc" class={labelClass}>Cc</label>
      <div class="flex min-w-0 items-center gap-2">
        <Input id="compose-cc" name="cc" bind:value={cc} autocomplete="off" class="h-8" data-testid="compose-cc" />
        {#if !showBcc}
          <Button type="button" size="sm" variant="ghost" onclick={revealBcc} aria-controls="compose-bcc-row" aria-expanded="false" data-testid="compose-show-bcc">Bcc</Button>
        {/if}
      </div>
    </div>
    {#if showBcc}
      <div class={fieldClass} id="compose-bcc-row">
        <label for="compose-bcc" class={labelClass}>Bcc</label>
        <Input id="compose-bcc" name="bcc" bind:ref={bccInput} bind:value={bcc} autocomplete="off" class="h-8" data-testid="compose-bcc" />
      </div>
    {:else}
      <input type="hidden" name="bcc" value={bcc} />
    {/if}
    <div class={fieldClass}>
      <label for="compose-subject" class={labelClass}>Subject</label>
      <Input id="compose-subject" name="subject" bind:value={subject} maxlength={500} class="h-8" data-testid="compose-subject" />
    </div>

    <label for="compose-body" class="sr-only">Message</label>
    <Textarea id="compose-body" name="body" bind:ref={bodyInput} bind:value={body} rows={14} class="min-h-[14rem] font-sans text-sm" data-testid="compose-body" />

    {#if draft.forwarded.length > 0 || draft.notForwarded.length > 0}
      <ul class="flex flex-wrap gap-2" aria-label="Forwarded attachments" data-testid="compose-forwarded">
        {#each draft.forwarded as a, i (i)}
          <li class="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs">
            <Paperclip class="size-3.5" aria-hidden="true" />{a.filename} <span class="text-muted-foreground">{fileSize(a.sizeBytes)}</span>
          </li>
        {/each}
        {#each draft.notForwarded as a, i (i)}
          <li class="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted-foreground" data-testid="compose-not-forwarded">
            <Paperclip class="size-3.5" aria-hidden="true" />{a.filename} · not included: {a.reason}
          </li>
        {/each}
      </ul>
    {/if}

    <div class="grid gap-1">
      <label for="compose-attachments" class={labelClass}>Attach files (up to 25 MB together)</label>
      <input id="compose-attachments" name="attachments" type="file" multiple class="text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-2.5 file:py-1 file:text-sm" data-testid="compose-attachments" />
    </div>

    <div class="flex flex-wrap items-center gap-2 pt-1">
      <Button type="submit" size="sm" disabled={busy || draft.blocked !== null} data-testid="compose-send">{busy ? 'Sending…' : 'Send'}</Button>
      <Button href={discardHref} size="sm" variant="outline" data-testid="compose-discard">Discard</Button>
      {#if busy}<span class="text-xs text-muted-foreground" role="status">Sending…</span>{/if}
    </div>
  </form>
</section>
