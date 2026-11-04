<script lang="ts" module>
  export type RowPerson = { id: string; name: string; image: string | null }
</script>

<script lang="ts">
  import FileText from '@lucide/svelte/icons/file-text'
  import MessageSquare from '@lucide/svelte/icons/message-square-text'
  import Pencil from '@lucide/svelte/icons/pencil'
  import SmilePlus from '@lucide/svelte/icons/smile-plus'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import { resolve } from '$app/paths'
  import UserAvatar from '$lib/components/user-avatar.svelte'
  import { renderMessageMarkdown, type MentionOptions } from './markdown'
  import MessageEdit from './message-edit.svelte'
  import { formatSize, reactedBy, reactionTitle, relativeTime, threadSummary, type MessageView } from './view'

  /**
   * One message, Slack-style: avatar + bold name + time, or — continuing the
   * same person's run — just the body with the time in the gutter on hover.
   * A floating toolbar (react, reply in thread, edit, delete) appears at the
   * row's top right on hover/focus; reactions are pills under the body; a
   * thread shows its summary with the latest repliers' avatars.
   */
  let {
    message: m,
    grouped = false,
    inThread = false,
    me,
    canEdit = false,
    canDelete = false,
    editing = false,
    pickerOpen = false,
    reactionEmoji,
    repliers = [],
    mentions,
    now = new Date(),
    onreact,
    ontogglepicker,
    onreply,
    onstartedit,
    onsaveedit,
    oncanceledit,
    ondelete,
  }: {
    message: MessageView
    grouped?: boolean
    inThread?: boolean
    me: string
    canEdit?: boolean
    canDelete?: boolean
    editing?: boolean
    pickerOpen?: boolean
    reactionEmoji: readonly string[]
    /** The thread's latest repliers (resolved to people), for the summary. */
    repliers?: RowPerson[]
    mentions?: MentionOptions
    now?: Date
    onreact: (emoji: string) => void
    ontogglepicker: () => void
    onreply?: () => void
    onstartedit?: () => void
    onsaveedit?: (body: string) => void
    oncanceledit?: () => void
    ondelete?: () => void
  } = $props()

  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
  const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' })
  const at = $derived(new Date(m.createdAt))
  const toolbar = $derived(!m.deleted && !editing)
</script>

<article
  class={[
    'group/row relative flex gap-2 px-4 py-0.5 hover:bg-foreground/[0.03] focus-within:bg-foreground/[0.03] sm:px-5',
    grouped ? '' : 'mt-2 pt-1.5',
    pickerOpen ? 'bg-foreground/[0.03]' : '',
  ]}
  data-testid={inThread ? 'thread-item' : 'messages-item'}
  data-id={m.id}
  data-grouped={grouped ? 'true' : 'false'}
>
  <div class="w-9 shrink-0">
    {#if grouped}
      <time
        class="invisible block pt-0.5 text-right text-[10px] leading-5 text-muted-foreground tabular-nums group-hover/row:visible group-focus-within/row:visible"
        datetime={m.createdAt}
        title={fullFmt.format(at)}
        data-testid="messages-gutter-time">{timeFmt.format(at)}</time
      >
    {:else}
      <UserAvatar name={m.authorName} image={m.authorImage} size="md" class="mt-0.5" testid="messages-avatar" />
    {/if}
  </div>

  <div class="min-w-0 flex-1">
    {#if !grouped}
      <p class="flex items-baseline gap-2 leading-5">
        <span class="text-[15px] font-bold" data-testid="messages-author">{m.authorName}</span>
        <time class="text-xs text-muted-foreground" datetime={m.createdAt} title={fullFmt.format(at)}>{timeFmt.format(at)}</time>
      </p>
    {/if}

    {#if m.deleted}
      <p class="text-sm leading-6 text-muted-foreground italic" data-testid="messages-deleted">Message deleted</p>
    {:else if editing}
      <MessageEdit body={m.body} onsave={(b) => onsaveedit?.(b)} oncancel={() => oncanceledit?.()} />
    {:else}
      {#if m.body}
        <div class="message-body text-[15px] leading-6 break-words" data-testid="messages-body">
          <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized by renderMessageMarkdown (DOMPurify allowlist) -->
          {@html renderMessageMarkdown(m.body, mentions)}
        </div>
      {/if}
      {#if m.editedAt}<span class="text-[11px] text-muted-foreground" title={fullFmt.format(new Date(m.editedAt))} data-testid="messages-edited"
          >(edited)</span
        >{/if}

      {#if m.attachments.length > 0}
        <div class="mt-1.5 flex flex-wrap gap-2" data-testid="messages-attachments">
          {#each m.attachments as f (f.fileId)}
            {#if f.image}
              <a
                href={resolve(`/drive/file/${f.fileId}`)}
                class="block overflow-hidden rounded-lg border border-border bg-foreground/[0.02] hover:border-foreground/25"
                title={f.name}
                data-testid="messages-attachment-image"
                data-name={f.name}
              >
                <img
                  src={`/api/drive/files/${encodeURIComponent(f.fileId)}/content`}
                  alt={f.name}
                  loading="lazy"
                  class="block max-h-72 max-w-80 object-cover"
                />
              </a>
            {:else}
              <a
                href={resolve(`/drive/file/${f.fileId}`)}
                class="flex w-72 max-w-full min-w-0 items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5 hover:border-foreground/25 hover:bg-foreground/[0.02]"
                data-testid="messages-attachment-file"
                data-name={f.name}
              >
                <span class="grid size-10 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                  <FileText class="size-5" aria-hidden="true" />
                </span>
                <span class="min-w-0">
                  <span class="block truncate text-sm font-semibold">{f.name}</span>
                  <span class="block text-xs text-muted-foreground">{formatSize(f.size)} · Open in Drive</span>
                </span>
              </a>
            {/if}
          {/each}
        </div>
      {/if}
    {/if}

    {#if !m.deleted && m.reactions.length > 0}
      <div class="mt-1 flex flex-wrap items-center gap-1" data-testid="messages-reactions">
        {#each m.reactions as r (r.emoji)}
          {@const mine = reactedBy(r, me)}
          <button
            type="button"
            class={[
              'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs font-medium tabular-nums',
              mine ? 'border-primary/60 bg-primary/10 text-primary' : 'border-border bg-foreground/[0.03] hover:border-foreground/30',
            ]}
            title={reactionTitle(r)}
            aria-label="{r.emoji} {r.userIds.length}: {reactionTitle(r)}"
            aria-pressed={mine}
            data-testid="messages-reaction"
            data-emoji={r.emoji}
            data-count={r.userIds.length}
            onclick={() => onreact(r.emoji)}><span aria-hidden="true" class="text-sm leading-none">{r.emoji}</span>{r.userIds.length}</button
          >
        {/each}
        <button
          type="button"
          class="inline-flex h-6 items-center rounded-full border border-transparent px-1.5 text-muted-foreground opacity-0 group-hover/row:opacity-100 hover:border-border hover:text-foreground focus-visible:opacity-100"
          aria-label="Add reaction"
          title="Add reaction"
          onclick={ontogglepicker}><SmilePlus class="size-3.5" /></button
        >
      </div>
    {/if}

    {#if !inThread && m.replyCount > 0}
      <button
        type="button"
        class="mt-1 -ml-1 flex max-w-full items-center gap-2 rounded-md border border-transparent px-1 py-0.5 text-left hover:border-border hover:bg-background"
        title={threadSummary(m, now)}
        data-testid="messages-thread-link"
        data-count={m.replyCount}
        onclick={() => onreply?.()}
      >
        {#if repliers.length > 0}
          <span class="flex shrink-0 -space-x-1" aria-hidden="true">
            {#each repliers as p (p.id)}
              <UserAvatar name={p.name} image={p.image} size="xs" class="ring-2 ring-background" testid="messages-replier" />
            {/each}
          </span>
        {/if}
        <span class="truncate text-xs">
          <span class="font-semibold text-primary">{m.replyCount} {m.replyCount === 1 ? 'reply' : 'replies'}</span>
          {#if m.lastReplyAt}<span class="text-muted-foreground"> · last reply {relativeTime(m.lastReplyAt, now)}</span>{/if}
        </span>
      </button>
    {/if}
  </div>

  {#if toolbar}
    <div
      class={[
        'absolute -top-3.5 right-4 z-10 items-center gap-px rounded-lg border border-border bg-background p-0.5 shadow-sm',
        pickerOpen ? 'flex' : 'hidden group-hover/row:flex group-focus-within/row:flex',
      ]}
      role="toolbar"
      aria-label="Message actions"
      data-testid="messages-actions"
    >
      <button
        type="button"
        class="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
        aria-label="Add reaction"
        title="Add reaction"
        data-testid="messages-react"
        onclick={ontogglepicker}><SmilePlus class="size-4" /></button
      >
      {#if !inThread}
        <button
          type="button"
          class="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
          aria-label="Reply in thread"
          title="Reply in thread"
          data-testid="messages-reply"
          onclick={() => onreply?.()}><MessageSquare class="size-4" /></button
        >
      {/if}
      {#if canEdit}
        <button
          type="button"
          class="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
          aria-label="Edit message"
          title="Edit"
          data-testid="messages-edit-start"
          onclick={() => onstartedit?.()}><Pencil class="size-4" /></button
        >
      {/if}
      {#if canDelete}
        <button
          type="button"
          class="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          aria-label="Delete message"
          title={m.authorId === me ? 'Delete' : 'Delete (moderation)'}
          data-testid="messages-delete"
          onclick={() => ondelete?.()}><Trash2 class="size-4" /></button
        >
      {/if}
      {#if pickerOpen}
        <div
          class="absolute top-full right-0 z-20 mt-1 grid w-max grid-cols-5 gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-md"
          role="menu"
          aria-label="Pick a reaction"
          data-testid="messages-picker"
        >
          {#each reactionEmoji as emoji (emoji)}
            <button
              type="button"
              role="menuitem"
              class="grid size-8 place-items-center rounded-md text-lg hover:bg-foreground/[0.06]"
              aria-label="React {emoji}"
              data-testid="messages-picker-emoji"
              data-emoji={emoji}
              onclick={() => onreact(emoji)}>{emoji}</button
            >
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</article>

<style>
  .message-body :global(p) {
    margin: 0;
  }
  .message-body :global(p + p),
  .message-body :global(ul),
  .message-body :global(ol),
  .message-body :global(pre),
  .message-body :global(blockquote) {
    margin-top: 0.25rem;
  }
  .message-body :global(ul) {
    list-style: disc;
    padding-left: 1.25rem;
  }
  .message-body :global(ol) {
    list-style: decimal;
    padding-left: 1.25rem;
  }
  .message-body :global(code) {
    border: 1px solid color-mix(in oklab, currentColor 12%, transparent);
    border-radius: 0.25rem;
    background: color-mix(in oklab, currentColor 5%, transparent);
    padding: 0.05rem 0.3rem;
    font-size: 0.85em;
    color: var(--destructive);
  }
  .message-body :global(pre) {
    overflow-x: auto;
    border: 1px solid color-mix(in oklab, currentColor 12%, transparent);
    border-radius: 0.375rem;
    background: color-mix(in oklab, currentColor 4%, transparent);
    padding: 0.5rem 0.75rem;
  }
  .message-body :global(pre code) {
    border: 0;
    background: none;
    padding: 0;
    color: inherit;
  }
  .message-body :global(blockquote) {
    border-left: 3px solid var(--border);
    padding-left: 0.75rem;
    color: var(--muted-foreground);
  }
  .message-body :global(a) {
    color: var(--primary);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .message-body :global(span[data-mention]) {
    border-radius: 0.25rem;
    background: color-mix(in oklab, var(--primary) 12%, transparent);
    padding: 0 0.15rem;
    font-weight: 600;
    color: var(--primary);
  }
  .message-body :global(span[data-mention='me']) {
    background: color-mix(in oklab, var(--primary) 22%, transparent);
  }
</style>
