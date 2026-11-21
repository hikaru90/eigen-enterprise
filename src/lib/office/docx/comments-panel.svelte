<script lang="ts">
  import type { CommentData } from './comments'
  import CircleCheckIcon from '@lucide/svelte/icons/circle-check'
  import MessageSquarePlusIcon from '@lucide/svelte/icons/message-square-plus'
  import PencilIcon from '@lucide/svelte/icons/pencil'
  import ReplyIcon from '@lucide/svelte/icons/reply'
  import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw'
  import TrashIcon from '@lucide/svelte/icons/trash'
  import { Button } from '$lib/components/ui/button'
  import { Textarea } from '$lib/components/ui/textarea'
  import { authorColor } from './review-colors'

  /**
   * The comments margin of a Word document: threads in document order
   * (each comment with its replies), author, initials, date and resolved
   * state. With `editable`, the signed-in member (`me`) adds a comment on
   * the selected text, replies, edits their own, resolves or reopens and
   * deletes. Without `me`, commenting stays off and says so.
   */
  let {
    comments,
    me,
    editable,
    canAdd,
    active,
    hint = null,
    onselect,
    onadd,
    onreply,
    onedit,
    ondone,
    ondelete,
  }: {
    comments: readonly CommentData[]
    /** The signed-in member's name, or null when unknown. */
    me: string | null
    /** Comments can be changed here (the Edit layout, not read-only). */
    editable: boolean
    /** Text is selected to comment on. */
    canAdd: boolean
    active: string | null
    /** Why the comments can't be changed right now, shown when not editable. */
    hint?: string | null
    onselect: (id: string) => void
    onadd: (text: string) => void
    onreply: (id: string, text: string) => void
    onedit: (id: string, text: string) => void
    ondone: (id: string, done: boolean) => void
    ondelete: (id: string) => void
  } = $props()

  type Thread = { root: CommentData; replies: CommentData[] }
  const threads = $derived.by(() => {
    const ids = new Set(comments.map((c) => c.id))
    const out: Thread[] = []
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a lookup built inside the derived, never mutated after
    const byRoot = new Map<string, Thread>()
    for (const c of comments) {
      if (c.parentId && ids.has(c.parentId)) continue
      const t = { root: c, replies: [] as CommentData[] }
      out.push(t)
      byRoot.set(c.id, t)
    }
    for (const c of comments) if (c.parentId && ids.has(c.parentId)) byRoot.get(c.parentId)?.replies.push(c)
    return out
  })

  /** What's being written: a new comment, a reply to a thread, or an edit of one comment. */
  type Draft = { kind: 'new' } | { kind: 'reply'; id: string } | { kind: 'edit'; id: string }
  let draft = $state<Draft | null>(null)
  let text = $state('')

  function open(d: Draft, initial = '') {
    draft = d
    text = initial
  }

  function submit(event: SubmitEvent) {
    event.preventDefault()
    const value = text.trim()
    if (!draft || !value) return
    if (draft.kind === 'new') onadd(value)
    else if (draft.kind === 'reply') onreply(draft.id, value)
    else onedit(draft.id, value)
    draft = null
    text = ''
  }

  const canWrite = $derived(editable && me !== null)
  const fmtDate = (iso: string | null) => {
    if (!iso) return ''
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  }
  const isDraft = (kind: Draft['kind'], id?: string) => draft?.kind === kind && (id === undefined || (draft.kind !== 'new' && draft.id === id))
</script>

{#snippet editor(label: string)}
  <form class="mt-2 flex flex-col gap-1.5" onsubmit={submit} data-testid="docx-comment-form">
    <Textarea class="min-h-16 text-xs" aria-label={label} bind:value={text} data-testid="docx-comment-input" />
    <div class="flex gap-1.5">
      <Button size="sm" class="h-7 text-xs" type="submit" disabled={!text.trim()} data-testid="docx-comment-save">{label}</Button>
      <Button size="sm" variant="ghost" class="h-7 text-xs" type="button" onclick={() => (draft = null)}>Cancel</Button>
    </div>
  </form>
{/snippet}

{#snippet comment(c: CommentData)}
  <div class="flex flex-col gap-0.5" data-testid="docx-comment" data-comment-id={c.id}>
    <div class="flex items-center gap-1.5">
      <span class="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white" style:background={authorColor(c.author)} aria-hidden="true">{c.initials || '?'}</span>
      <span class="truncate text-xs font-medium" data-testid="docx-comment-author">{c.author || 'Unknown author'}</span>
      <time class="ms-auto shrink-0 text-xs text-muted-foreground" datetime={c.date ?? undefined}>{fmtDate(c.date)}</time>
    </div>
    {#if isDraft('edit', c.id)}
      {@render editor('Save')}
    {:else}
      <p class="whitespace-pre-wrap text-xs" data-testid="docx-comment-text">{c.text}</p>
    {/if}
    {#if canWrite && !draft}
      <div class="flex flex-wrap gap-0.5">
        {#if c.author === me}
          <Button variant="ghost" size="sm" class="h-6 px-1.5 text-xs" onclick={() => open({ kind: 'edit', id: c.id }, c.text)} aria-label="Edit comment"><PencilIcon class="size-3" />Edit</Button>
        {/if}
        <Button variant="ghost" size="sm" class="h-6 px-1.5 text-xs" onclick={() => ondelete(c.id)} aria-label="Delete comment"><TrashIcon class="size-3" />Delete</Button>
      </div>
    {/if}
  </div>
{/snippet}

<aside class="flex w-72 shrink-0 flex-col border-s bg-background text-sm" aria-label="Comments" data-testid="docx-comments">
  <div class="flex items-center gap-2 border-b px-3 py-2">
    <h2 class="text-xs font-semibold">Comments ({comments.length})</h2>
    {#if canWrite}
      <Button variant="outline" size="sm" class="ms-auto h-7 text-xs" disabled={!canAdd || draft !== null} onclick={() => open({ kind: 'new' })} title={canAdd ? 'Comment on the selected text' : 'Select some text to comment on it'} data-testid="docx-comment-add">
        <MessageSquarePlusIcon />Comment
      </Button>
    {/if}
  </div>
  {#if me === null}
    <p class="border-b px-3 py-2 text-xs text-muted-foreground" data-testid="docx-comments-off">Your name isn't known here, so adding and answering comments is off.</p>
  {:else if !editable && hint}
    <p class="border-b px-3 py-2 text-xs text-muted-foreground" data-testid="docx-comments-hint">{hint}</p>
  {/if}
  <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2">
    {#if isDraft('new')}
      <div class="rounded-md border p-2">{@render editor('Comment')}</div>
    {/if}
    {#each threads as t (t.root.id)}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (the thread's buttons are the keyboard path; a click anywhere shows its text) -->
      <div
        class="flex flex-col gap-2 rounded-md border p-2"
        class:border-primary={active === t.root.id}
        class:opacity-60={t.root.done}
        data-testid="docx-thread"
        data-done={t.root.done ? '1' : '0'}
        data-active={active === t.root.id ? '1' : '0'}
        onclick={() => onselect(t.root.id)}
      >
        {#if t.root.done}<span class="text-xs font-medium text-muted-foreground" data-testid="docx-thread-resolved">Resolved</span>{/if}
        {@render comment(t.root)}
        {#each t.replies as r (r.id)}
          <div class="border-s-2 ps-2">{@render comment(r)}</div>
        {/each}
        {#if isDraft('reply', t.root.id)}
          {@render editor('Reply')}
        {:else if canWrite && !draft}
          <div class="flex flex-wrap gap-0.5 border-t pt-1">
            {#if !t.root.done}
              <Button variant="ghost" size="sm" class="h-6 px-1.5 text-xs" onclick={() => open({ kind: 'reply', id: t.root.id })} data-testid="docx-comment-reply"><ReplyIcon class="size-3" />Reply</Button>
              <Button variant="ghost" size="sm" class="h-6 px-1.5 text-xs" onclick={() => ondone(t.root.id, true)} data-testid="docx-comment-resolve"><CircleCheckIcon class="size-3" />Resolve</Button>
            {:else}
              <Button variant="ghost" size="sm" class="h-6 px-1.5 text-xs" onclick={() => ondone(t.root.id, false)} data-testid="docx-comment-reopen"><RotateCcwIcon class="size-3" />Reopen</Button>
            {/if}
          </div>
        {/if}
      </div>
    {:else}
      <p class="px-1 py-2 text-xs text-muted-foreground">No comments yet.{canWrite ? ' Select text and choose Comment.' : ''}</p>
    {/each}
  </div>
</aside>
