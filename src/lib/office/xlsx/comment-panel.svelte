<script lang="ts">
  import { enterSends } from '$lib/components/keys/enter-sends'
  import type { Note } from './notes'
  import type { Member, Thread } from './threads'
  import AtSignIcon from '@lucide/svelte/icons/at-sign'
  import CheckIcon from '@lucide/svelte/icons/check'
  import EyeIcon from '@lucide/svelte/icons/eye'
  import EyeOffIcon from '@lucide/svelte/icons/eye-off'
  import MessageSquarePlusIcon from '@lucide/svelte/icons/message-square-plus'
  import PencilIcon from '@lucide/svelte/icons/pencil'
  import ReplyIcon from '@lucide/svelte/icons/reply'
  import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw'
  import StickyNoteIcon from '@lucide/svelte/icons/sticky-note'
  import TrashIcon from '@lucide/svelte/icons/trash'
  import XIcon from '@lucide/svelte/icons/x'
  import { Button } from '$lib/components/ui/button'
  import { Textarea } from '$lib/components/ui/textarea'
  import { m } from '$lib/paraglide/messages.js'

  /**
   * Side panel for worksheet threaded comments (with company member
   * @mentions, replies, edits, resolve/reopen, and delete) and legacy notes
   * (text, author, Show Note visibility toggle, edit, and delete).
   */
  let {
    sheet,
    activeRef,
    editable,
    author,
    members,
    threads,
    notes,
    focusRef = null,
    onjump,
    onaddthread,
    onreply,
    oneditcomment,
    onresolve,
    ondeletecomment,
    onsetnote,
    ondeletenote,
    onclose,
  }: {
    sheet: string
    activeRef: string
    editable: boolean
    author: { id: string; name: string } | null
    members: Member[]
    threads: Thread[]
    notes: Note[]
    focusRef?: string | null
    onjump: (row: number, col: number, ref: string) => void
    onaddthread: (ref: string, text: string, mentions: Member[]) => Promise<boolean>
    onreply: (threadId: string, text: string, mentions: Member[]) => Promise<boolean>
    oneditcomment: (id: string, text: string, mentions: Member[]) => Promise<boolean>
    onresolve: (threadId: string, resolved: boolean) => Promise<boolean>
    ondeletecomment: (id: string) => Promise<boolean>
    onsetnote: (ref: string, text: string | undefined, visible: boolean | undefined) => Promise<boolean>
    ondeletenote: (ref: string) => Promise<boolean>
    onclose: () => void
  } = $props()

  type ComposerMode =
    | { kind: 'new_thread'; ref: string }
    | { kind: 'new_note'; ref: string }
    | { kind: 'reply'; threadId: string }
    | { kind: 'edit_comment'; id: string }
    | { kind: 'edit_note'; ref: string }

  let composer = $state<ComposerMode | null>(null)
  let draft = $state('')
  let chosenMentions = $state<Member[]>([])
  let mentionQuery = $state<string | null>(null)
  let mentionOpen = $state(false)
  let busy = $state(false)

  const canWrite = $derived(editable && author !== null)
  const activeHasThread = $derived(threads.some((t) => t.ref === activeRef))
  const activeHasNote = $derived(notes.some((n) => n.ref === activeRef))

  const mentionMatches = $derived.by(() => {
    if (mentionQuery === null) return mentionOpen ? members : []
    const q = mentionQuery.toLowerCase()
    return members.filter((mem) => mem.name.toLowerCase().includes(q))
  })

  function openComposer(next: ComposerMode, initial = '') {
    composer = next
    draft = initial
    chosenMentions = []
    mentionQuery = null
    mentionOpen = false
  }

  function closeComposer() {
    composer = null
    draft = ''
    chosenMentions = []
    mentionQuery = null
    mentionOpen = false
  }

  function updateMentionHint(value: string) {
    const match = /(?:^|\s)@([^\s@]{0,30})$/.exec(value)
    mentionQuery = match ? match[1]! : null
    mentionOpen = match !== null && members.length > 0
  }

  function insertMention(mem: Member) {
    if (mentionQuery !== null) {
      draft = draft.replace(/(^|\s)@[^\s@]{0,30}$/, `$1@${mem.name} `)
    } else {
      draft = `${draft}${draft && !draft.endsWith(' ') ? ' ' : ''}@${mem.name} `
    }
    if (!chosenMentions.some((x) => x.id === mem.id)) chosenMentions = [...chosenMentions, mem]
    mentionQuery = null
    mentionOpen = false
  }

  function collectMentions(text: string): Member[] {
    const out = [...chosenMentions]
    // A plain lookup inside one call (not state).
    const seen: Record<string, true> = Object.fromEntries(out.map((m) => [m.id, true]))
    for (const mem of members) {
      if (seen[mem.id]) continue
      const tag = `@${mem.name}`
      let idx = text.indexOf(tag)
      while (idx >= 0) {
        const next = text[idx + tag.length]
        if (next === undefined || !/[\p{L}\p{N}_]/u.test(next)) {
          out.push(mem)
          seen[mem.id] = true
          break
        }
        idx = text.indexOf(tag, idx + 1)
      }
    }
    return out
  }

  async function submitComposer(event: SubmitEvent) {
    event.preventDefault()
    const text = draft.trim()
    if (!composer || !text || busy) return
    const cur = composer
    busy = true
    try {
      let ok = false
      if (cur.kind === 'new_thread') ok = await onaddthread(cur.ref, text, collectMentions(text))
      else if (cur.kind === 'reply') ok = await onreply(cur.threadId, text, collectMentions(text))
      else if (cur.kind === 'edit_comment') ok = await oneditcomment(cur.id, text, collectMentions(text))
      else if (cur.kind === 'new_note') ok = await onsetnote(cur.ref, text, false)
      else if (cur.kind === 'edit_note') ok = await onsetnote(cur.ref, text, undefined)
      if (ok) closeComposer()
    } finally {
      busy = false
    }
  }

  function formatAt(iso: string): string {
    if (!iso) return ''
    const d = new Date(iso)
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
  }

  function isOwnComment(authorId: string | null): boolean {
    return author !== null && authorId === author.id
  }
</script>

{#snippet formBlock(label: string, placeholder: string, submitLabel: string, allowMentions: boolean)}
  <form
    class="mt-2 flex flex-col gap-1.5 rounded border bg-muted/25 p-2"
    onsubmit={(e) => void submitComposer(e)}
    data-testid="xlsx-comment-form"
  >
    <Textarea
      class="min-h-16 bg-background text-xs"
      aria-label={label}
      {placeholder}
      bind:value={draft}
      oninput={(e) => {
        if (allowMentions) updateMentionHint(e.currentTarget.value)
      }}
      onkeydown={(e) => {
        e.stopPropagation()
        enterSends()(e)
      }}
      data-testid="xlsx-comment-input"
    />
    {#if allowMentions && mentionOpen && mentionMatches.length > 0}
      <ul
        class="max-h-28 overflow-y-auto rounded border bg-popover text-xs shadow-sm"
        data-testid="xlsx-mention-menu"
      >
        {#each mentionMatches as mem (mem.id)}
          <li>
            <button
              type="button"
              class="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-muted"
              onclick={() => insertMention(mem)}
              data-testid="xlsx-mention-option"
              data-member-id={mem.id}
            >
              <AtSignIcon class="size-3 text-muted-foreground" aria-hidden="true" />
              <span>{mem.name}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    <div class="flex items-center gap-1">
      {#if allowMentions && members.length > 0}
        <Button
          type="button"
          size="xs"
          variant="outline"
          onclick={() => (mentionOpen = !mentionOpen)}
          title={m.drive_sheet_mention_member()}
          aria-label={m.drive_sheet_mention_member()}
          data-testid="xlsx-mention-trigger"
        >
          <AtSignIcon class="size-3" aria-hidden="true" />
        </Button>
      {/if}
      <div class="ml-auto flex gap-1">
        <Button type="button" size="xs" variant="ghost" onclick={closeComposer} disabled={busy}>
          {m.drive_sheet_cancel()}
        </Button>
        <Button
          type="submit"
          size="xs"
          disabled={busy || draft.trim() === ''}
          data-testid="xlsx-comment-submit"
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  </form>
{/snippet}

<aside
  class="flex w-80 shrink-0 flex-col border-l bg-background text-sm"
  aria-label={m.drive_sheet_comments_title()}
  data-testid="xlsx-comments-panel"
>
  <div class="flex items-center gap-2 border-b px-3 py-2">
    <span class="font-medium">{m.drive_sheet_comments_title()}</span>
    <span class="text-xs text-muted-foreground">({sheet})</span>
    <button
      type="button"
      class="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      onclick={onclose}
      aria-label={m.drive_sheet_comments_close()}
      data-testid="xlsx-comments-close"
    >
      <XIcon class="size-4" aria-hidden="true" />
    </button>
  </div>

  {#if editable}
    <div class="flex flex-col gap-1.5 border-b px-3 py-2">
      {#if !canWrite}
        <p class="text-xs text-muted-foreground" data-testid="xlsx-comments-no-author">
          {m.drive_sheet_comments_no_author()}
        </p>
      {:else}
        <div class="flex flex-wrap gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={activeHasThread || activeHasNote}
            onclick={() => openComposer({ kind: 'new_thread', ref: activeRef })}
            data-testid="xlsx-new-comment-btn"
          >
            <MessageSquarePlusIcon class="mr-1 size-3.5" aria-hidden="true" />
            {m.drive_sheet_comment_new({ ref: activeRef })}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={activeHasThread || activeHasNote}
            onclick={() => openComposer({ kind: 'new_note', ref: activeRef })}
            data-testid="xlsx-new-note-btn"
          >
            <StickyNoteIcon class="mr-1 size-3.5" aria-hidden="true" />
            {m.drive_sheet_note_new({ ref: activeRef })}
          </Button>
        </div>
        {#if composer?.kind === 'new_thread'}
          {@render formBlock(
            m.drive_sheet_comment_new({ ref: composer.ref }),
            m.drive_sheet_comment_placeholder(),
            m.drive_sheet_comment_post(),
            true,
          )}
        {:else if composer?.kind === 'new_note'}
          {@render formBlock(
            m.drive_sheet_note_new({ ref: composer.ref }),
            m.drive_sheet_note_placeholder(),
            m.drive_sheet_note_save(),
            false,
          )}
        {/if}
      {/if}
    </div>
  {/if}

  <div class="flex-1 space-y-2 overflow-y-auto p-3">
    {#if threads.length === 0 && notes.length === 0}
      <p class="py-6 text-center text-xs text-muted-foreground" data-testid="xlsx-comments-empty">
        {m.drive_sheet_comments_empty()}
      </p>
    {/if}

    {#each threads as t (t.id)}
      <article
        class="rounded-md border p-2.5 {focusRef === t.ref ? 'border-primary ring-1 ring-primary' : ''} {t.resolved
          ? 'opacity-70'
          : ''}"
        data-testid="xlsx-thread-card"
        data-ref={t.ref}
        data-resolved={t.resolved ? 'true' : 'false'}
      >
        <div class="flex items-center gap-1.5">
          <button
            type="button"
            class="rounded bg-violet-100 px-1.5 py-0.5 font-mono text-xs font-medium text-violet-900 hover:bg-violet-200 dark:bg-violet-900/40 dark:text-violet-200"
            onclick={() => onjump(t.row, t.col, t.ref)}
            data-testid="xlsx-thread-jump"
          >
            {t.ref}
          </button>
          {#if t.resolved}
            <span
              class="rounded-full border px-1.5 text-xs text-muted-foreground"
              data-testid="xlsx-thread-resolved"
            >
              {m.drive_sheet_comment_resolved()}
            </span>
          {/if}
          {#if canWrite}
            <div class="ml-auto flex items-center gap-0.5">
              <button
                type="button"
                class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                title={t.resolved ? m.drive_sheet_comment_reopen() : m.drive_sheet_comment_resolve()}
                aria-label={t.resolved ? m.drive_sheet_comment_reopen() : m.drive_sheet_comment_resolve()}
                onclick={() => void onresolve(t.id, !t.resolved)}
                data-testid="xlsx-thread-resolve"
              >
                {#if t.resolved}
                  <RotateCcwIcon class="size-3.5" aria-hidden="true" />
                {:else}
                  <CheckIcon class="size-3.5" aria-hidden="true" />
                {/if}
              </button>
              <button
                type="button"
                class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                title={m.drive_sheet_comment_reply()}
                aria-label={m.drive_sheet_comment_reply()}
                onclick={() => openComposer({ kind: 'reply', threadId: t.id })}
                data-testid="xlsx-thread-reply-btn"
              >
                <ReplyIcon class="size-3.5" aria-hidden="true" />
              </button>
            </div>
          {/if}
        </div>

        <ul class="mt-2 space-y-2">
          {#each t.comments as c, idx (c.id)}
            <li
              class={idx > 0 ? 'border-l-2 border-border pl-2' : ''}
              data-testid="xlsx-thread-comment"
              data-comment-id={c.id}
            >
              <div class="flex items-baseline gap-1.5 text-xs">
                <span class="font-medium">{c.author || 'Unknown'}</span>
                <span class="text-xs text-muted-foreground">{formatAt(c.at)}</span>
                {#if canWrite && (idx === 0 || isOwnComment(c.authorId))}
                  <div class="ml-auto flex gap-0.5">
                    {#if isOwnComment(c.authorId)}
                      <button
                        type="button"
                        class="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        title={m.drive_sheet_comment_edit()}
                        aria-label={m.drive_sheet_comment_edit()}
                        onclick={() => openComposer({ kind: 'edit_comment', id: c.id }, c.text)}
                        data-testid="xlsx-comment-edit-btn"
                      >
                        <PencilIcon class="size-3" aria-hidden="true" />
                      </button>
                    {/if}
                    <button
                      type="button"
                      class="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                      title={m.drive_sheet_comment_delete()}
                      aria-label={m.drive_sheet_comment_delete()}
                      onclick={() => void ondeletecomment(c.id)}
                      data-testid="xlsx-comment-delete-btn"
                    >
                      <TrashIcon class="size-3" aria-hidden="true" />
                    </button>
                  </div>
                {/if}
              </div>
              {#if composer?.kind === 'edit_comment' && composer.id === c.id}
                {@render formBlock(
                  m.drive_sheet_comment_edit(),
                  m.drive_sheet_comment_placeholder(),
                  m.drive_sheet_comment_save(),
                  true,
                )}
              {:else}
                <p class="mt-0.5 text-xs whitespace-pre-wrap">{c.text}</p>
              {/if}
            </li>
          {/each}
        </ul>

        {#if composer?.kind === 'reply' && composer.threadId === t.id}
          {@render formBlock(
            m.drive_sheet_comment_reply(),
            m.drive_sheet_comment_reply_placeholder(),
            m.drive_sheet_comment_send_reply(),
            true,
          )}
        {/if}
      </article>
    {/each}

    {#each notes as n (n.ref)}
      <article
        class="rounded-md border border-amber-300/70 bg-amber-50/40 p-2.5 dark:border-amber-700/60 dark:bg-amber-950/20 {focusRef === n.ref
          ? 'ring-1 ring-primary'
          : ''}"
        data-testid="xlsx-note-card"
        data-ref={n.ref}
      >
        <div class="flex items-center gap-1.5">
          <button
            type="button"
            class="rounded bg-amber-200/80 px-1.5 py-0.5 font-mono text-xs font-medium text-amber-950 hover:bg-amber-300/80"
            onclick={() => onjump(n.row, n.col, n.ref)}
            data-testid="xlsx-note-jump"
          >
            {n.ref}
          </button>
          <span class="text-xs font-medium text-amber-900 dark:text-amber-200">
            {m.drive_sheet_note_label()}
          </span>
          {#if editable}
            <div class="ml-auto flex items-center gap-0.5">
              <button
                type="button"
                class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                title={n.visible ? m.drive_sheet_note_hide() : m.drive_sheet_note_show()}
                aria-label={n.visible ? m.drive_sheet_note_hide() : m.drive_sheet_note_show()}
                onclick={() => void onsetnote(n.ref, undefined, !n.visible)}
                data-testid="xlsx-note-visible-toggle"
              >
                {#if n.visible}
                  <EyeIcon class="size-3.5" aria-hidden="true" />
                {:else}
                  <EyeOffIcon class="size-3.5" aria-hidden="true" />
                {/if}
              </button>
              <button
                type="button"
                class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                title={m.drive_sheet_comment_edit()}
                aria-label={m.drive_sheet_comment_edit()}
                onclick={() => openComposer({ kind: 'edit_note', ref: n.ref }, n.text)}
                data-testid="xlsx-note-edit-btn"
              >
                <PencilIcon class="size-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                title={m.drive_sheet_comment_delete()}
                aria-label={m.drive_sheet_comment_delete()}
                onclick={() => void ondeletenote(n.ref)}
                data-testid="xlsx-note-delete-btn"
              >
                <TrashIcon class="size-3.5" aria-hidden="true" />
              </button>
            </div>
          {/if}
        </div>
        {#if n.author}
          <p class="mt-1 text-xs font-medium text-muted-foreground">{n.author}</p>
        {/if}
        {#if composer?.kind === 'edit_note' && composer.ref === n.ref}
          {@render formBlock(
            m.drive_sheet_comment_edit(),
            m.drive_sheet_note_placeholder(),
            m.drive_sheet_note_save(),
            false,
          )}
        {:else}
          <p class="mt-1 text-xs whitespace-pre-wrap">{n.text}</p>
        {/if}
      </article>
    {/each}
  </div>
</aside>
