<script lang="ts" module>
  /** A new comment waiting for its text: where it goes, said in words. */
  export type PendingComment = { label: string }
</script>

<script lang="ts">
  import type { Slide } from './model'
  import MapPinIcon from '@lucide/svelte/icons/map-pin'
  import MessageSquarePlusIcon from '@lucide/svelte/icons/message-square-plus'
  import XIcon from '@lucide/svelte/icons/x'
  import { Button } from '$lib/components/ui/button'
  import { anchorName } from './comment-view'
  import { isMember, type CommentPerson, type SlideComment } from './comments'

  /**
   * The comments panel (S3): the current slide's threads, or every slide's
   * ("All slides", grouped by slide; picking one jumps there). Threads show
   * their author, time, status and what they are on, with their replies.
   * When commenting is on: new comments (on the slide, on the selected shape,
   * or at a point picked on the slide), replies, resolve/reopen, and editing
   * or deleting your own. Legacy comments are shown read-only, and say so.
   * Every change goes back to the viewer, which turns it into an operation.
   */
  let {
    slides,
    current,
    me,
    canComment,
    offReason,
    selectedShape,
    pending,
    focused,
    placing,
    deckError,
    onstart,
    onpost,
    oncancel,
    onreply,
    onedit,
    onstatus,
    ondelete,
    onjump,
    onclose,
  }: {
    slides: Slide[]
    current: number
    /** The signed-in member's id (for "your own"), or null when not known. */
    me: string | null
    canComment: boolean
    /** Why commenting is off (shown), or null. */
    offReason: string | null
    /** The single selected shape, which a new comment can go on. */
    selectedShape: { id: string; name: string } | null
    pending: PendingComment | null
    focused: string | null
    /** Waiting for a click on the slide (a point comment). */
    placing: boolean
    deckError: string | null
    onstart: (where: 'slide' | 'shape' | 'point') => void
    onpost: (text: string) => Promise<boolean>
    oncancel: () => void
    onreply: (slide: string, comment: string, text: string) => Promise<boolean>
    onedit: (slide: string, comment: string, reply: string | null, text: string) => Promise<boolean>
    onstatus: (slide: string, comment: string, status: 'active' | 'resolved') => Promise<boolean>
    ondelete: (slide: string, comment: string, reply: string | null) => Promise<boolean>
    onjump: (slide: number, comment: string) => void
    onclose: () => void
  } = $props()

  let scope = $state<'slide' | 'all'>('slide')
  let draft = $state('')
  let replyFor = $state<string | null>(null)
  let replyText = $state('')
  /** What is being edited: "comment" or "comment/reply". */
  let editing = $state<string | null>(null)
  let editText = $state('')
  let busy = $state(false)

  const here = $derived(slides[current] ?? null)
  const total = $derived(slides.reduce((n, s) => n + s.comments.threads.length, 0))

  const who = (p: CommentPerson | null) => p?.name || 'Unknown author'
  const mine = (p: CommentPerson | null) => me !== null && isMember(p, me)

  function when(iso: string | null): string {
    if (!iso) return ''
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  }

  async function run(fn: () => Promise<boolean>, after: () => void) {
    busy = true
    try {
      if (await fn()) after()
    } finally {
      busy = false
    }
  }

  function post() {
    const text = draft
    void run(
      () => onpost(text),
      () => (draft = ''),
    )
  }
  function cancelPending() {
    draft = ''
    oncancel()
  }
  function startReply(id: string) {
    replyFor = id
    replyText = ''
    editing = null
  }
  function sendReply(slide: Slide, t: SlideComment) {
    const text = replyText
    void run(
      () => onreply(slide.part, t.id, text),
      () => {
        replyFor = null
        replyText = ''
      },
    )
  }
  function startEdit(key: string, text: string) {
    editing = key
    editText = text
    replyFor = null
  }
  function saveEdit(slide: Slide, t: SlideComment, reply: string | null) {
    const text = editText
    void run(
      () => onedit(slide.part, t.id, reply, text),
      () => (editing = null),
    )
  }

  /** Brings the focused thread into view when it is drawn. */
  function reveal(node: HTMLElement) {
    node.scrollIntoView?.({ block: 'nearest' })
  }

  function onComposerKey(e: KeyboardEvent, send: () => void) {
    e.stopPropagation()
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      send()
    }
  }
</script>

{#snippet thread(slide: Slide, index: number, t: SlideComment, n: number)}
  {@const legacy = t.format === 'legacy'}
  {@const on = anchorName(slide, t)}
  <li
    class={`rounded-md border p-2.5 text-sm ${focused === t.id ? 'border-primary ring-1 ring-primary' : ''} ${t.status !== 'active' && !legacy ? 'opacity-70' : ''}`}
    data-testid="pptx-thread"
    data-id={t.id}
    data-status={t.status}
    data-format={t.format}
    {@attach focused === t.id ? reveal : undefined}
  >
    <div class="flex items-baseline gap-1.5">
      <span class="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-amber-300 text-xs font-semibold text-amber-950" aria-hidden="true">{n}</span>
      <span class="font-medium" data-testid="pptx-thread-author">{who(t.author)}</span>
      <span class="text-xs text-muted-foreground">{when(t.created)}</span>
    </div>
    <div class="mt-1 flex flex-wrap gap-1 text-xs text-muted-foreground">
      {#if t.status === 'resolved'}<span class="rounded-full border px-1.5" data-testid="pptx-thread-resolved">Resolved</span>{/if}
      {#if t.status === 'closed'}<span class="rounded-full border px-1.5">Closed</span>{/if}
      {#if t.anchor.kind === 'shape'}<span class="rounded-full border px-1.5">On {on ? `“${on}”` : `shape ${t.anchor.shape} (no longer on the slide)`}</span>{/if}
      {#if t.anchor.kind === 'text'}<span class="rounded-full border px-1.5">On text in {on ? `“${on}”` : `shape ${t.anchor.shape} (no longer on the slide)`}</span>{/if}
      {#if legacy}<span class="rounded-full border border-amber-400 px-1.5 text-amber-800 dark:text-amber-300" data-testid="pptx-thread-legacy">Older-format comment, read-only</span>{/if}
    </div>
    {#if editing === t.id}
      <textarea class="mt-1.5 block min-h-14 w-full rounded-md border bg-background px-2 py-1 text-sm" aria-label="Edit comment" bind:value={editText} onkeydown={(e) => onComposerKey(e, () => saveEdit(slide, t, null))} data-testid="pptx-comment-edit-text"></textarea>
      <div class="mt-1 flex gap-1.5">
        <Button size="sm" class="h-7" disabled={busy || !editText.trim()} onclick={() => saveEdit(slide, t, null)} data-testid="pptx-comment-save">Save</Button>
        <Button size="sm" variant="ghost" class="h-7" onclick={() => (editing = null)}>Cancel</Button>
      </div>
    {:else}
      <p class="mt-1 whitespace-pre-wrap" data-testid="pptx-thread-text">{t.text}</p>
    {/if}
    {#if t.replies.length}
      <ol class="mt-2 flex flex-col gap-2 border-l-2 pl-2.5" aria-label="Replies">
        {#each t.replies as r (r.id)}
          <li data-testid="pptx-reply" data-id={r.id}>
            <div class="flex items-baseline gap-1.5">
              <span class="text-xs font-medium">{who(r.author)}</span>
              <span class="text-xs text-muted-foreground">{when(r.created)}</span>
            </div>
            {#if editing === `${t.id}/${r.id}`}
              <textarea class="mt-1 block min-h-12 w-full rounded-md border bg-background px-2 py-1 text-sm" aria-label="Edit reply" bind:value={editText} onkeydown={(e) => onComposerKey(e, () => saveEdit(slide, t, r.id))} data-testid="pptx-comment-edit-text"></textarea>
              <div class="mt-1 flex gap-1.5">
                <Button size="sm" class="h-7" disabled={busy || !editText.trim()} onclick={() => saveEdit(slide, t, r.id)} data-testid="pptx-comment-save">Save</Button>
                <Button size="sm" variant="ghost" class="h-7" onclick={() => (editing = null)}>Cancel</Button>
              </div>
            {:else}
              <p class="text-sm whitespace-pre-wrap" data-testid="pptx-reply-text">{r.text}</p>
              {#if canComment && !legacy && mine(r.author)}
                <div class="flex gap-2 text-xs">
                  <button type="button" class="text-muted-foreground hover:text-foreground" onclick={() => startEdit(`${t.id}/${r.id}`, r.text)} data-testid="pptx-reply-edit">Edit</button>
                  <button type="button" class="text-destructive hover:underline" disabled={busy} onclick={() => void run(() => ondelete(slide.part, t.id, r.id), () => {})} data-testid="pptx-reply-delete">Delete</button>
                </div>
              {/if}
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
    {#if scope === 'all'}
      <button type="button" class="mt-1.5 text-xs text-primary hover:underline" onclick={() => {
          scope = 'slide'
          onjump(index, t.id)
        }}
        data-testid="pptx-thread-jump">Go to slide {index + 1}</button>
    {:else if canComment && !legacy}
      {#if replyFor === t.id}
        <textarea class="mt-2 block min-h-12 w-full rounded-md border bg-background px-2 py-1 text-sm" aria-label="Reply" placeholder="Reply" bind:value={replyText} onkeydown={(e) => onComposerKey(e, () => sendReply(slide, t))} data-testid="pptx-reply-text-input"></textarea>
        <div class="mt-1 flex gap-1.5">
          <Button size="sm" class="h-7" disabled={busy || !replyText.trim()} onclick={() => sendReply(slide, t)} data-testid="pptx-reply-send">Reply</Button>
          <Button size="sm" variant="ghost" class="h-7" onclick={() => (replyFor = null)}>Cancel</Button>
        </div>
      {:else}
        <div class="mt-2 flex flex-wrap gap-3 text-xs">
          <button type="button" class="text-muted-foreground hover:text-foreground" onclick={() => startReply(t.id)} data-testid="pptx-thread-reply">Reply</button>
          {#if t.status === 'resolved'}
            <button type="button" class="text-muted-foreground hover:text-foreground" disabled={busy} onclick={() => void run(() => onstatus(slide.part, t.id, 'active'), () => {})} data-testid="pptx-thread-reopen">Reopen</button>
          {:else}
            <button type="button" class="text-muted-foreground hover:text-foreground" disabled={busy} onclick={() => void run(() => onstatus(slide.part, t.id, 'resolved'), () => {})} data-testid="pptx-thread-resolve">Resolve</button>
          {/if}
          {#if mine(t.author)}
            <button type="button" class="text-muted-foreground hover:text-foreground" onclick={() => startEdit(t.id, t.text)} data-testid="pptx-thread-edit">Edit</button>
            <button type="button" class="text-destructive hover:underline" disabled={busy} onclick={() => void run(() => ondelete(slide.part, t.id, null), () => {})} data-testid="pptx-thread-delete">Delete</button>
          {/if}
        </div>
      {/if}
    {/if}
  </li>
{/snippet}

{#snippet notes(slide: Slide)}
  {#if slide.comments.legacyIgnored}
    <p class="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" data-testid="pptx-legacy-ignored">
      This slide also has {slide.comments.legacyIgnored} older-format comment{slide.comments.legacyIgnored === 1 ? '' : 's'}. Its threaded comments replace them, as in PowerPoint, so they are kept in the file but not shown.
    </p>
  {/if}
  {#if slide.comments.error && slide.comments.error !== deckError}
    <p class="text-xs text-destructive" role="alert" data-testid="pptx-comments-error">{slide.comments.error}</p>
  {/if}
{/snippet}

<aside class="flex w-72 shrink-0 flex-col border-l" aria-label="Comments" data-testid="pptx-comments">
  <div class="flex items-center gap-1 border-b px-2 py-1.5">
    <div class="flex gap-0.5 rounded-md bg-muted p-0.5 text-xs" role="tablist" aria-label="Which comments">
      <button type="button" role="tab" aria-selected={scope === 'slide'} class={`rounded px-2 py-0.5 ${scope === 'slide' ? 'bg-background shadow-sm' : ''}`} onclick={() => (scope = 'slide')} data-testid="pptx-comments-slide">This slide</button>
      <button type="button" role="tab" aria-selected={scope === 'all'} class={`rounded px-2 py-0.5 ${scope === 'all' ? 'bg-background shadow-sm' : ''}`} onclick={() => (scope = 'all')} data-testid="pptx-comments-all">All slides ({total})</button>
    </div>
    <button type="button" class="ml-auto rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Close comments" onclick={onclose}><XIcon class="size-3.5" aria-hidden="true" /></button>
  </div>

  <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
    {#if deckError}
      <p class="text-xs text-destructive" role="alert" data-testid="pptx-comments-error">{deckError}</p>
    {/if}
    {#if offReason}
      <p class="text-xs text-muted-foreground" data-testid="pptx-comments-off">{offReason}</p>
    {/if}

    {#if scope === 'slide' && here}
      {#if canComment}
        {#if pending}
          <div class="rounded-md border border-primary p-2" data-testid="pptx-comment-composer">
            <p class="mb-1 text-xs text-muted-foreground" data-testid="pptx-comment-where">{pending.label}</p>
            <!-- svelte-ignore a11y_autofocus -->
            <textarea class="block min-h-16 w-full rounded-md border bg-background px-2 py-1 text-sm" aria-label="New comment" placeholder="Write a comment" autofocus bind:value={draft} onkeydown={(e) => onComposerKey(e, post)} data-testid="pptx-comment-text"></textarea>
            <div class="mt-1 flex gap-1.5">
              <Button size="sm" class="h-7" disabled={busy || !draft.trim()} onclick={post} data-testid="pptx-comment-post">Comment</Button>
              <Button size="sm" variant="ghost" class="h-7" onclick={cancelPending} data-testid="pptx-comment-cancel">Cancel</Button>
            </div>
          </div>
        {:else if placing}
          <p class="rounded-md border border-dashed px-2 py-1.5 text-xs" data-testid="pptx-comment-placing">
            Click the slide where the comment goes. <button type="button" class="text-primary hover:underline" onclick={oncancel}>Cancel</button>
          </p>
        {:else}
          <div class="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" class="h-7 text-xs" onclick={() => onstart('slide')} data-testid="pptx-comment-new"><MessageSquarePlusIcon class="size-3.5" aria-hidden="true" /> Comment on slide</Button>
            <Button size="sm" variant="outline" class="h-7 text-xs" onclick={() => onstart('point')} data-testid="pptx-comment-point"><MapPinIcon class="size-3.5" aria-hidden="true" /> At a point</Button>
            {#if selectedShape}
              <Button size="sm" variant="outline" class="h-7 text-xs" onclick={() => onstart('shape')} data-testid="pptx-comment-shape">On “{selectedShape.name}”</Button>
            {/if}
          </div>
        {/if}
      {/if}
      {@render notes(here)}
      {#if here.comments.threads.length === 0}
        <p class="text-xs text-muted-foreground" data-testid="pptx-comments-none">No comments on this slide.</p>
      {:else}
        <ol class="flex flex-col gap-2" aria-label={`Comments on slide ${current + 1}`}>
          {#each here.comments.threads as t, n (t.id)}{@render thread(here, current, t, n + 1)}{/each}
        </ol>
      {/if}
    {:else if scope === 'all'}
      {#if total === 0}
        <p class="text-xs text-muted-foreground" data-testid="pptx-comments-none">No comments in this presentation.</p>
      {/if}
      {#each slides as s, i (s.part)}
        {#if s.comments.threads.length || s.comments.legacyIgnored || (s.comments.error && s.comments.error !== deckError)}
          <section class="flex flex-col gap-2" aria-label={`Slide ${i + 1}`} data-testid="pptx-comments-group">
            <h3 class="text-xs font-medium text-muted-foreground">Slide {i + 1}</h3>
            {@render notes(s)}
            <ol class="flex flex-col gap-2">
              {#each s.comments.threads as t, n (t.id)}{@render thread(s, i, t, n + 1)}{/each}
            </ol>
          </section>
        {/if}
      {/each}
    {/if}
  </div>
</aside>
