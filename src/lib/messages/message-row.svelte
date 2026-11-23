<script lang="ts" module>
  export type RowPerson = { id: string; name: string; image: string | null; kind?: 'human' | 'coworker' }
</script>

<script lang="ts">
  import FileText from '@lucide/svelte/icons/file-text'
  import MessageSquare from '@lucide/svelte/icons/message-square-text'
  import Pencil from '@lucide/svelte/icons/pencil'
  import Phone from '@lucide/svelte/icons/phone'
  import PhoneMissed from '@lucide/svelte/icons/phone-missed'
  import Plus from '@lucide/svelte/icons/plus'
  import Reply from '@lucide/svelte/icons/reply'
  import SmilePlus from '@lucide/svelte/icons/smile-plus'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import { tick } from 'svelte'
  import { resolve } from '$app/paths'
  import { callLineLabel } from '$lib/calls/format'
  import UserAvatar from '$lib/components/user-avatar.svelte'
  import AiMark from '$lib/coworkers/ai-mark.svelte'
  import { m as msg } from '$lib/paraglide/messages.js'
  import EmojiPicker from './emoji-picker.svelte'
  import { renderMessageMarkdown, type MentionOptions } from './markdown'
  import MessageEdit from './message-edit.svelte'
  import ReplyQuote from './reply-quote.svelte'
  import { formatSize, reactedBy, reactionTitle, relativeTime, threadSummary, voiceClipUrl, type MessageView } from './view'
  import VoicePlayer from './voice-player.svelte'

  /**
   * One message, Slack-style: avatar + bold name + time, or — continuing the
   * same person's run — just the body with the time in the gutter on hover.
   * A floating toolbar (react, reply in thread, edit, delete) appears at the
   * row's top right on hover/focus; reactions are pills under the body; a
   * thread shows its summary with the latest repliers' avatars.
   * "Reply" (Contribute 2a58bcc8) quotes the message in the composer: from the
   * toolbar, the row's context menu (right-click, the menu key, Shift+F10) or
   * R on a focused row. A reply shows its quote above the text; clicking it
   * jumps to the original.
   * The reaction picker is a quick row of frequent emoji plus "More emoji",
   * which swaps it for the full picker (search, categories, recently used).
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
    onquote,
    onopenquote,
    highlighted = false,
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
    /** Shows "Reply": quote this message in the composer. */
    onquote?: () => void
    /** The quote above this reply was clicked: show the original. */
    onopenquote?: () => void
    /** Briefly marked: the original a quote jumped to. */
    highlighted?: boolean
  } = $props()

  let rowEl = $state<HTMLElement | null>(null)
  let reactEl = $state<HTMLButtonElement | null>(null)
  /** The full picker instead of the quick row; every open starts at the quick row. */
  let fullPicker = $state(false)

  function togglePicker() {
    fullPicker = false
    ontogglepicker()
  }

  /** Esc in the full picker: close it and give focus back to the react button. */
  function closeFullPicker() {
    fullPicker = false
    ontogglepicker()
    reactEl?.focus()
  }
  let menuEl = $state<HTMLDivElement | null>(null)
  let menu = $state<{ x: number; y: number } | null>(null)
  const MENU_WIDTH = 200

  /** Our menu instead of the browser's, except over a link, an image or selected text, which keep theirs. */
  async function onContextMenu(e: MouseEvent) {
    if (!toolbar || !rowEl) return
    const target = e.target as Element | null
    if (target?.closest('a, img, textarea, input')) return
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed && rowEl.contains(selection.anchorNode)) return
    e.preventDefault()
    const rect = rowEl.getBoundingClientRect()
    // The menu key / Shift+F10 report no pointer position: open at the row's top right.
    const fromKeyboard = e.clientX === 0 && e.clientY === 0
    const x = fromKeyboard ? rect.width - MENU_WIDTH - 16 : e.clientX - rect.left
    menu = { x: Math.max(8, Math.min(x, rect.width - MENU_WIDTH - 8)), y: fromKeyboard ? 8 : e.clientY - rect.top }
    await tick()
    menuEl?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }

  function closeMenu(refocus = false) {
    menu = null
    if (refocus) rowEl?.focus()
  }

  function pick(action: (() => void) | undefined) {
    closeMenu()
    action?.()
  }

  function onMenuKey(e: KeyboardEvent) {
    if (!menuEl) return
    const items = [...menuEl.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeMenu(true)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[next]?.focus()
    } else if (e.key === 'Tab') {
      closeMenu()
    }
  }

  function onMenuFocusOut(e: FocusEvent) {
    const next = e.relatedTarget as Node | null
    if (!next || !menuEl?.contains(next)) closeMenu()
  }

  /** R on the focused row replies (the row itself, never while typing in it). */
  function onRowKey(e: KeyboardEvent) {
    if (e.target !== rowEl || !toolbar || !onquote) return
    if (e.key.toLowerCase() === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      onquote()
    }
  }

  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
  const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' })
  const at = $derived(new Date(m.createdAt))
  const toolbar = $derived(!m.deleted && !editing)
</script>

{#snippet edited(at: string)}
  <span class="ml-1 text-xs text-muted-foreground" title={fullFmt.format(new Date(at))} data-testid="messages-edited">(edited)</span>
{/snippet}

<!-- A focusable row (ARIA feed pattern): Tab reaches its actions, the menu key opens its menu, R replies. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<article
  bind:this={rowEl}
  class={[
    'group/row relative flex gap-2 px-4 py-0.5 transition-colors duration-700 outline-none hover:bg-foreground/[0.03] focus-within:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:px-5',
    grouped ? '' : 'mt-2 pt-1.5',
    pickerOpen || menu ? 'bg-foreground/[0.03]' : '',
    highlighted ? 'bg-(--tone-yellow)/25 hover:bg-(--tone-yellow)/25 focus-within:bg-(--tone-yellow)/25' : '',
  ]}
  tabindex="0"
  aria-label="{m.authorName}{m.authorKind === 'coworker' ? ` (${msg.coworkers_ai_mark_title()})` : ''}, {timeFmt.format(at)}"
  data-testid={inThread ? 'thread-item' : 'messages-item'}
  data-id={m.id}
  data-grouped={grouped ? 'true' : 'false'}
  data-highlighted={highlighted ? 'true' : undefined}
  oncontextmenu={onContextMenu}
  onkeydown={onRowKey}
>
  <div class="w-9 shrink-0">
    {#if grouped}
      <time
        class="invisible block pt-0.5 text-right text-xs leading-5 text-muted-foreground tabular-nums group-hover/row:visible group-focus-within/row:visible"
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
        {#if m.authorKind === 'coworker'}<AiMark class="self-center" testid="messages-author-ai" />{/if}
        <time class="text-xs text-muted-foreground" datetime={m.createdAt} title={fullFmt.format(at)}>{timeFmt.format(at)}</time>
      </p>
    {/if}

    {#if m.replyTo && !m.deleted}
      <ReplyQuote quote={m.replyTo} onopen={() => onopenquote?.()} />
    {/if}

    {#if m.deleted}
      <p class="text-sm leading-6 text-muted-foreground italic" data-testid="messages-deleted">Message deleted</p>
    {:else if m.call}
      {@const answered = m.call.outcome === 'ended'}
      <p
        class={[
          'mt-0.5 inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm font-medium',
          answered ? 'border-border bg-foreground/[0.03]' : 'border-destructive/30 bg-destructive/5 text-destructive',
        ]}
        data-testid="messages-call-line"
        data-outcome={m.call.outcome}
      >
        {#if answered}<Phone class="size-4 text-muted-foreground" aria-hidden="true" />{:else}<PhoneMissed class="size-4" aria-hidden="true" />{/if}
        {callLineLabel(m.call)}
      </p>
    {:else if editing}
      <MessageEdit body={m.body} onsave={(b) => onsaveedit?.(b)} oncancel={() => oncanceledit?.()} />
    {:else}
      {#each m.voice as clip (clip.fileId)}
        <div class="mt-0.5 mb-1"><VoicePlayer src={voiceClipUrl(m.id, clip.fileId)} durationMs={clip.durationMs} testid="messages-voice" /></div>
      {/each}
      {#if m.body}
        <div class="message-body text-[15px] leading-6 break-words" data-testid="messages-body">
          <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized by renderMessageMarkdown (DOMPurify allowlist) -->
          {@html renderMessageMarkdown(m.body, mentions)}
          {#if m.editedAt}{@render edited(m.editedAt)}{/if}
        </div>
      {:else if m.editedAt}
        {@render edited(m.editedAt)}
      {/if}

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
          onclick={togglePicker}><SmilePlus class="size-3.5" /></button
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
        bind:this={reactEl}
        onclick={togglePicker}><SmilePlus class="size-4" /></button
      >
      {#if onquote}
        <button
          type="button"
          class="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
          aria-label="Reply"
          title="Reply (R)"
          data-testid="messages-quote"
          onclick={() => onquote()}><Reply class="size-4" /></button
        >
      {/if}
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
      {#if pickerOpen && fullPicker}
        <div class="absolute top-full right-0 z-20 mt-1">
          <EmojiPicker label="Pick a reaction" onpick={(emoji) => onreact(emoji)} onclose={closeFullPicker} />
        </div>
      {:else if pickerOpen}
        <div
          class="absolute top-full right-0 z-20 mt-1 grid w-max grid-cols-6 gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-md"
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
          <button
            type="button"
            role="menuitem"
            class="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
            aria-label="More emoji"
            title="More emoji"
            data-testid="messages-picker-more"
            onclick={() => (fullPicker = true)}><Plus class="size-4" /></button
          >
        </div>
      {/if}
    </div>
  {/if}

  {#if menu && toolbar}
    <div
      bind:this={menuEl}
      class="absolute z-30 grid rounded-lg border border-border bg-popover p-1 text-sm shadow-md"
      style:left="{menu.x}px"
      style:top="{menu.y}px"
      style:width="{MENU_WIDTH}px"
      role="menu"
      tabindex="-1"
      aria-label="Message actions"
      data-testid="messages-context-menu"
      onkeydown={onMenuKey}
      onfocusout={onMenuFocusOut}
    >
      {#if onquote}{@render item('Reply', 'messages-menu-quote', Reply, onquote)}{/if}
      {#if !inThread && onreply}{@render item('Reply in thread', 'messages-menu-thread', MessageSquare, onreply)}{/if}
      {@render item('Add reaction', 'messages-menu-react', SmilePlus, togglePicker)}
      {#if canEdit}{@render item('Edit', 'messages-menu-edit', Pencil, onstartedit)}{/if}
      {#if canDelete}{@render item('Delete', 'messages-menu-delete', Trash2, ondelete, true)}{/if}
    </div>
  {/if}
</article>

{#snippet item(label: string, testid: string, Icon: typeof Reply, action: (() => void) | undefined, danger = false)}
  <button
    type="button"
    role="menuitem"
    class={[
      'flex h-8 items-center gap-2 rounded-md px-2 text-left outline-none',
      danger ? 'text-destructive hover:bg-destructive/10 focus:bg-destructive/10' : 'hover:bg-foreground/[0.06] focus:bg-foreground/[0.06]',
    ]}
    data-testid={testid}
    onclick={() => pick(action)}><Icon class={['size-4 shrink-0', danger ? '' : 'text-muted-foreground']} aria-hidden="true" />{label}</button
  >
{/snippet}

<style>
  .message-body :global(p) {
    margin: 0;
  }
  /* "(edited)" sits on the last line of a plain message, like Slack. */
  .message-body :global(p:last-of-type) {
    display: inline;
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
