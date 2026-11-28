<script lang="ts">
  import { enterSends } from '$lib/components/keys/enter-sends'
  import CircleCheckIcon from '@lucide/svelte/icons/circle-check'
  import Trash2Icon from '@lucide/svelte/icons/trash-2'
  import { Button } from '$lib/components/ui/button'
  import DictationField from '$lib/voice/dictation-field.svelte'
  import { kindLabel, rgbHex, type PdfAnnotation } from './annotate-model'

  /**
   * The comments list of the PDF editor (P3): every note and markup with its
   * author and date, its replies, and whether it is reviewed (the Review
   * state model, ISO 32000-2 §12.5.6.3: Completed = reviewed). Clicking one
   * selects it on its page.
   */
  let {
    threads,
    selected,
    canStage,
    onselect,
    onreply,
    onreview,
    oncontents,
    ondelete,
  }: {
    threads: Array<{ root: PdfAnnotation; replies: PdfAnnotation[] }>
    selected: string | null
    canStage: boolean
    onselect: (id: string) => void
    onreply: (id: string, text: string) => void
    onreview: (id: string, reviewed: boolean) => void
    oncontents: (id: string, text: string) => void
    ondelete: (id: string) => void
  } = $props()

  let replying = $state<string | null>(null)
  let replyText = $state('')
  let editing = $state<string | null>(null)
  let editText = $state('')
  let editEl = $state<HTMLTextAreaElement | null>(null)
  let replyEl = $state<HTMLTextAreaElement | null>(null)

  const date = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : 'no date'
  const reviewed = (a: PdfAnnotation) => a.review?.state === 'Completed'

  function sendReply(id: string) {
    if (!replyText.trim()) return
    onreply(id, replyText)
    replying = null
    replyText = ''
  }

  function saveEdit(id: string) {
    oncontents(id, editText)
    editing = null
  }
</script>

<aside class="pdf-comments border-l bg-muted/20" aria-label="Comments" data-testid="pdf-comments">
  <h3 class="border-b px-3 py-2 text-sm font-medium">
    Comments <span class="text-muted-foreground tabular-nums">({threads.length})</span>
  </h3>
  {#if threads.length === 0}
    <p class="px-3 py-4 text-sm text-muted-foreground">
      No notes or markups yet. Pick a tool and mark up the page.
    </p>
  {/if}
  <ol class="flex flex-col">
    {#each threads as t (t.root.id)}
      {@const a = t.root}
      <li
        class="border-b px-3 py-2 text-sm"
        class:bg-muted={a.id === selected}
        data-testid="pdf-comment"
        data-annotation={a.id}
        data-reviewed={reviewed(a)}
      >
        <button
          type="button"
          class="flex w-full items-center gap-2 text-left"
          onclick={() => onselect(a.id)}
        >
          <span
            class="size-2.5 shrink-0 rounded-full"
            style:background={a.color ? rgbHex(a.color) : 'transparent'}
            aria-hidden="true"
          ></span>
          <span class="font-medium">{kindLabel(a.kind)}</span>
          <span class="text-xs text-muted-foreground">p. {a.page + 1}</span>
          {#if reviewed(a)}
            <CircleCheckIcon class="ml-auto size-4 text-emerald-600" aria-label="Reviewed" />
          {:else if a.review && a.review.state !== 'None'}
            <span class="ml-auto text-xs text-muted-foreground">{a.review.state}</span>
          {/if}
        </button>
        <p class="text-xs text-muted-foreground">
          {a.author ?? 'Unknown author'} · {date(a.modified ?? a.created)}
        </p>
        {#if editing === a.id}
          <DictationField field={editEl} kind="textarea" testid="pdf-comment-edit-voice" class="mt-1">
            <textarea
              bind:this={editEl}
              class="h-16 w-full rounded border bg-background p-1 pr-10 text-sm"
              aria-label="Comment text"
              onkeydown={enterSends(() => {
                if (a.kind !== 'FreeText' || editText.trim()) saveEdit(a.id)
              })}
              bind:value={editText}></textarea>
          </DictationField>
          <div class="flex justify-end gap-1">
            <Button size="sm" variant="ghost" onclick={() => (editing = null)}>Cancel</Button>
            <Button
              size="sm"
              disabled={a.kind === 'FreeText' && !editText.trim()}
              onclick={() => saveEdit(a.id)}>Apply</Button
            >
          </div>
        {:else if a.contents}
          <p class="mt-1 whitespace-pre-wrap" data-testid="pdf-comment-text">{a.contents}</p>
        {/if}
        {#if t.replies.length}
          <ol class="mt-1 flex flex-col gap-1 border-l-2 pl-2">
            {#each t.replies as r (r.id)}
              <li data-testid="pdf-comment-reply">
                <p class="text-xs text-muted-foreground">
                  {r.author ?? 'Unknown author'} · {date(r.modified ?? r.created)}
                </p>
                <p class="whitespace-pre-wrap">{r.contents}</p>
              </li>
            {/each}
          </ol>
        {/if}
        {#if canStage}
          {#if replying === a.id}
            <form
              class="mt-1 flex flex-col gap-1"
              onsubmit={(e) => {
                e.preventDefault()
                sendReply(a.id)
              }}
            >
              <DictationField field={replyEl} kind="textarea" testid="pdf-comment-reply-voice">
                <textarea
                  bind:this={replyEl}
                  class="h-14 w-full rounded border bg-background p-1 pr-10 text-sm"
                  aria-label="Reply"
                  placeholder="Reply…"
                  onkeydown={enterSends()}
                  bind:value={replyText}></textarea>
              </DictationField>
              <div class="flex justify-end gap-1">
                <Button size="sm" variant="ghost" onclick={() => (replying = null)}>Cancel</Button>
                <Button
                  size="sm"
                  type="submit"
                  disabled={!replyText.trim()}
                  data-testid="pdf-comment-send">Reply</Button
                >
              </div>
            </form>
          {:else}
            <div class="mt-1 flex flex-wrap items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                onclick={() => {
                  replying = a.id
                  replyText = ''
                }}
                data-testid="pdf-comment-reply-start">Reply</Button
              >
              {#if a.kind === 'Text' || a.kind === 'FreeText' || a.contents}
                <Button
                  size="sm"
                  variant="ghost"
                  onclick={() => {
                    editing = a.id
                    editText = a.contents
                  }}>Edit</Button
                >
              {/if}
              <label class="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={reviewed(a)}
                  onchange={(e) => onreview(a.id, e.currentTarget.checked)}
                  data-testid="pdf-comment-reviewed"
                />
                Reviewed
              </label>
              <Button
                size="icon-sm"
                variant="ghost"
                class="ml-auto"
                aria-label="Delete"
                title="Delete (with its replies)"
                onclick={() => ondelete(a.id)}><Trash2Icon class="size-4" /></Button
              >
            </div>
          {/if}
        {/if}
      </li>
    {/each}
  </ol>
</aside>

<style>
  .pdf-comments {
    width: 17rem;
    flex-shrink: 0;
    overflow-y: auto;
  }
</style>
