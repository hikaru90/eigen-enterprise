<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- hrefs come from the page, built on resolve('/m/email/inbox') */
  import type { Folder } from '../types'
  import type { FolderView, LabelView } from '../view'
  import type { SubmitFunction } from '@sveltejs/kit'
  import Archive from '@lucide/svelte/icons/archive'
  import Inbox from '@lucide/svelte/icons/inbox'
  import OctagonAlert from '@lucide/svelte/icons/octagon-alert'
  import Plus from '@lucide/svelte/icons/plus'
  import Send from '@lucide/svelte/icons/send'
  import Star from '@lucide/svelte/icons/star'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import X from '@lucide/svelte/icons/x'
  import { enhance } from '$app/forms'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { LABEL_COLORS } from '../types'
  import { LABEL_COLOR_NAMES, labelDot } from './display'

  /**
   * The mailbox's places, as a sidebar: the folders with unread counts (Sent shows none: it is never
   * unread), Starred right under the Inbox, then the mailbox's labels with "New label". Starred and a
   * label span every folder but Spam and Trash.
   */
  type Current = { kind: 'folder'; folder: Folder } | { kind: 'starred' } | { kind: 'label'; labelId: string }
  let {
    folders,
    current,
    href,
    starredHref,
    labels,
    labelHref,
    mailboxId,
    submit,
  }: {
    folders: FolderView[]
    current: Current
    href: (folder: Folder) => string
    starredHref: string
    labels: LabelView[]
    labelHref: (id: string) => string
    mailboxId: string
    submit: SubmitFunction
  } = $props()

  const ICONS: Record<Folder, typeof Inbox> = {
    inbox: Inbox,
    sent: Send,
    archive: Archive,
    spam: OctagonAlert,
    trash: Trash2,
  }
  /** Sidebar order: what you read first on top, what you rarely open last. */
  const ORDER: Folder[] = ['inbox', 'sent', 'archive', 'spam', 'trash']
  const byFolder = $derived(new Map(folders.map((f) => [f.folder, f])))
  let adding = $state(false)

  const row =
    'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60'
  const on = 'bg-muted font-medium text-foreground'
  const off = 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
</script>

<div class="flex flex-col gap-5">
  <nav aria-label="Folders" class="flex flex-col gap-0.5" data-testid="inbox-folders">
    {#each ORDER as folder (folder)}
      {@const f = byFolder.get(folder)}
      {#if f}
        {@const Icon = ICONS[folder]}
        {@const here = current.kind === 'folder' && current.folder === folder}
        {@const showUnread = folder !== 'sent' && f.unread > 0}
        <a
          href={href(folder)}
          aria-current={here ? 'page' : undefined}
          data-testid={`inbox-folder-${folder}`}
          class="{row} {here ? on : off}"
        >
          <Icon class="size-4 shrink-0" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate">{f.label}</span>
          {#if showUnread}
            <span class="text-[11px] font-semibold text-foreground tabular-nums" data-testid={`inbox-folder-${folder}-unread`}
              >{f.unread}<span class="sr-only">&nbsp;unread</span></span
            >
          {/if}
        </a>
        {#if folder === 'inbox'}
          <a
            href={starredHref}
            aria-current={current.kind === 'starred' ? 'page' : undefined}
            data-testid="inbox-view-starred"
            class="{row} {current.kind === 'starred' ? on : off}"
          >
            <Star class="size-4 shrink-0" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate">Starred</span>
          </a>
        {/if}
      {/if}
    {/each}
  </nav>

  <div class="flex flex-col gap-1">
    <div class="flex items-center justify-between px-2.5">
      <h3 class="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Labels</h3>
      <button
        type="button"
        class="rounded-md p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        aria-expanded={adding}
        aria-label="New label"
        data-testid="inbox-label-new"
        onclick={() => (adding = !adding)}><Plus class="size-3.5" aria-hidden="true" /></button
      >
    </div>
    {#if labels.length === 0 && !adding}
      <p class="px-2.5 text-xs text-muted-foreground">No labels yet.</p>
    {/if}
    {#if labels.length > 0}
      <nav aria-label="Labels" class="flex flex-col gap-0.5" data-testid="inbox-labels">
        {#each labels as l (l.id)}
          {@const here = current.kind === 'label' && current.labelId === l.id}
          <div class="group flex items-center">
            <a
              href={labelHref(l.id)}
              aria-current={here ? 'page' : undefined}
              data-testid={`inbox-label-${l.id}`}
              class="{row} {here ? on : off}"
            >
              <span class="size-2.5 shrink-0 rounded-full" style:background={labelDot(l.color)} aria-hidden="true"></span>
              <span class="min-w-0 flex-1 truncate">{l.name}</span>
            </a>
            <form
              method="POST"
              action="?/deleteLabel"
              class="hidden group-focus-within:block group-hover:block"
              use:enhance={(input) => {
                if (!confirm(`Remove the label “${l.name}”? It comes off every mail; the mail stays.`)) return input.cancel()
                return submit(input)
              }}
            >
              <input type="hidden" name="labelId" value={l.id} />
              <button
                type="submit"
                class="rounded-md p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
                aria-label={`Remove the label ${l.name}`}><X class="size-3.5" aria-hidden="true" /></button
              >
            </form>
          </div>
        {/each}
      </nav>
    {/if}
    {#if adding}
      <form
        method="POST"
        action="?/createLabel"
        class="mt-1 flex flex-col gap-2 rounded-md border border-border p-2.5"
        data-testid="inbox-label-form"
        use:enhance={(input) => {
          const after = submit(input)
          return async (opts) => {
            if (typeof after === 'function') await after(opts)
            if (opts.result.type === 'success') adding = false
          }
        }}
      >
        <input type="hidden" name="mailboxId" value={mailboxId} />
        <label class="sr-only" for="inbox-label-name">Label name</label>
        <Input id="inbox-label-name" name="name" required maxlength={40} placeholder="Label name" class="h-8" autocomplete="off" />
        <fieldset class="flex flex-wrap gap-1.5">
          <legend class="sr-only">Colour</legend>
          {#each LABEL_COLORS as c, i (c)}
            <label class="cursor-pointer">
              <input type="radio" name="color" value={c} checked={i === 0} class="peer sr-only" aria-label={LABEL_COLOR_NAMES[c]} />
              <span
                class="block size-5 rounded-full ring-offset-2 ring-offset-background peer-checked:ring-2 peer-checked:ring-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring"
                style:background={labelDot(c)}
                title={LABEL_COLOR_NAMES[c]}
              ></span>
            </label>
          {/each}
        </fieldset>
        <div class="flex gap-2">
          <Button type="submit" size="sm">Create label</Button>
          <Button type="button" size="sm" variant="ghost" onclick={() => (adding = false)}>Cancel</Button>
        </div>
      </form>
    {/if}
  </div>
</div>
