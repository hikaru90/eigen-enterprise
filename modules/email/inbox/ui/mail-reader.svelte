<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- hrefs come from the page, built on resolve('/m/email/inbox'); attachment links are same-origin download routes */
  import type { ReaderMessage, ReaderView } from '../view'
  import type { SubmitFunction } from '@sveltejs/kit'
  import ArrowLeft from '@lucide/svelte/icons/arrow-left'
  import Paperclip from '@lucide/svelte/icons/paperclip'
  import Star from '@lucide/svelte/icons/star'
  import { enhance } from '$app/forms'
  import { Button } from '$lib/components/ui/button'
  import { FOLDER_LABELS } from '../view'
  import { fileSize, fullWhen, moveActions, personFull, personLabel } from './display'

  /**
   * The open thread (oldest first). Actions apply to the opened mail and go
   * through SvelteKit form actions (`submit` is the page's enhance callback).
   * HTML mail renders in a sandboxed iframe — no scripts, no same-origin —
   * whose srcdoc carries its own CSP; remote images stay blocked until the
   * reader follows "Show images".
   */
  let {
    reader,
    backHref,
    imagesHref,
    submit,
    busy = false,
    error = null,
  }: {
    reader: ReaderView
    backHref: string
    imagesHref: string
    submit: SubmitFunction
    busy?: boolean
    error?: string | null
  } = $props()

  let heading: HTMLHeadingElement | undefined = $state()

  /** The page moves focus here after opening a mail. */
  export function focusHeading() {
    heading?.focus()
  }

  const moves = $derived(moveActions(reader.folder))
  const recipients = (m: ReaderMessage) => [...m.to, ...m.cc].map(personFull).join(', ')
</script>

{#snippet flagForm(action: string, label: string, testid: string, icon?: boolean)}
  <form method="POST" action={`?/${action}`} use:enhance={submit}>
    <input type="hidden" name="messageId" value={reader.id} />
    <Button type="submit" size="sm" variant="outline" disabled={busy} data-testid={testid}>
      {#if icon}<Star class={action === 'unstar' ? 'fill-current text-amber-500' : ''} aria-hidden="true" />{/if}
      {label}
    </Button>
  </form>
{/snippet}

<article class="flex min-w-0 flex-col" aria-labelledby="inbox-reader-heading" data-testid="inbox-reader" data-message-id={reader.id}>
  <div class="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
    <a
      href={backHref}
      class="mr-1 inline-flex items-center gap-1 rounded-md text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 md:hidden"
      data-testid="inbox-back"><ArrowLeft class="size-4" aria-hidden="true" />Back to list</a
    >
    <div class="flex flex-wrap items-center gap-2" role="group" aria-label="Actions for this mail">
      {#each moves as move (move.folder)}
        <form method="POST" action="?/move" use:enhance={submit}>
          <input type="hidden" name="messageId" value={reader.id} />
          <input type="hidden" name="folder" value={move.folder} />
          <Button type="submit" size="sm" variant="outline" disabled={busy} data-testid={`inbox-move-${move.folder}`}>{move.label}</Button>
        </form>
      {/each}
      {#if reader.unread}
        {@render flagForm('read', 'Mark read', 'inbox-mark-read')}
      {:else}
        {@render flagForm('unread', 'Mark unread', 'inbox-mark-unread')}
      {/if}
      {#if reader.starred}
        {@render flagForm('unstar', 'Unstar', 'inbox-unstar', true)}
      {:else}
        {@render flagForm('star', 'Star', 'inbox-star', true)}
      {/if}
    </div>
  </div>

  {#if error}<p class="px-4 pt-3 text-sm text-destructive" role="alert" data-testid="inbox-reader-error">{error}</p>{/if}

  <div class="px-4 pt-4">
    <h3 id="inbox-reader-heading" bind:this={heading} tabindex="-1" class="text-base font-semibold tracking-tight outline-none">
      {reader.subject || '(no subject)'}
    </h3>
    <p class="mt-0.5 text-xs text-muted-foreground">In {FOLDER_LABELS[reader.folder]}{reader.messages.length > 1 ? ` · ${reader.messages.length} mails in this conversation` : ''}</p>
  </div>

  {#if reader.remoteImagesBlocked}
    <div class="mx-4 mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2 text-[13px]" data-testid="inbox-images-blocked">
      <span class="text-muted-foreground">Remote images are blocked, so the sender can't see that you opened this mail.</span>
      <Button href={imagesHref} size="sm" variant="outline" data-testid="inbox-show-images">Show images</Button>
    </div>
  {/if}

  <ol class="flex flex-col gap-4 px-4 py-4" aria-label="Mails in this conversation">
    {#each reader.messages as m (m.id)}
      <li class="rounded-lg border border-border" data-testid={`inbox-thread-${m.id}`} aria-current={m.id === reader.id ? 'true' : undefined}>
        <header class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-border px-4 py-2.5">
          <span class="min-w-0">
            <span class="block truncate text-sm font-medium" title={personFull(m.from)}>{personLabel(m.from)}
              <span class="font-normal text-muted-foreground">&lt;{m.from.address}&gt;</span></span
            >
            {#if recipients(m)}<span class="block truncate text-xs text-muted-foreground">To {recipients(m)}</span>{/if}
          </span>
          <span class="flex items-center gap-2 text-xs text-muted-foreground">
            {#if m.id !== reader.id && m.folder !== reader.folder}<span class="rounded-full border border-border px-1.5">{FOLDER_LABELS[m.folder]}</span>{/if}
            <time datetime={m.receivedAt}>{fullWhen(m.receivedAt)}</time>
          </span>
        </header>
        {#if m.body.kind === 'html'}
          <iframe
            title={`Mail from ${personLabel(m.from)}`}
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            referrerpolicy="no-referrer"
            srcdoc={m.body.srcdoc}
            class="block h-[28rem] w-full rounded-b-lg bg-white"
            data-testid="inbox-html-body"
          ></iframe>
        {:else if m.body.kind === 'text'}
          <pre class="overflow-x-auto px-4 py-3 font-sans text-sm break-words whitespace-pre-wrap" data-testid="inbox-text-body">{m.body.text}</pre>
        {:else}
          <p class="px-4 py-3 text-sm text-muted-foreground">This mail has no text.</p>
        {/if}
        {#if m.attachments.length > 0}
          <ul class="flex flex-wrap gap-2 border-t border-border px-4 py-2.5" aria-label="Attachments" data-testid="inbox-attachments">
            {#each m.attachments as a (a.id)}
              <li>
                {#if a.blocked}
                  <span class="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive" data-testid={`inbox-attachment-blocked-${a.id}`}>
                    <Paperclip class="size-3.5" aria-hidden="true" />{a.filename} · Blocked: Amazon found a virus
                  </span>
                {:else}
                  <a
                    href={a.href}
                    download={a.filename}
                    rel="external"
                    class="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60"
                    data-testid={`inbox-attachment-${a.id}`}
                    ><Paperclip class="size-3.5" aria-hidden="true" />{a.filename}
                    <span class="text-muted-foreground">{fileSize(a.sizeBytes)}</span></a
                  >
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </li>
    {/each}
  </ol>
</article>
