<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { driveApi, formatSize, type Revision } from '$lib/drive/api'
  import CsvEditor from './csv-editor.svelte'
  import MarkdownEditor from './markdown-editor.svelte'

  /** The revisions of a Markdown/CSV file (newest first): who and when, view one, restore one (= a new revision). */
  let {
    fileId,
    kind,
    revisions,
    authors,
    canRestore,
    onrestore,
  }: {
    fileId: string
    kind: 'markdown' | 'csv'
    revisions: Revision[]
    authors: Record<string, string>
    canRestore: boolean
    onrestore: (revisionId: string) => Promise<void>
  } = $props()

  let error = $state<string | null>(null)
  let busy = $state<string | null>(null)
  let viewing = $state<{ revision: Revision; content: string; index: number } | null>(null)
  let open = $state(false)

  const fmt = (d: string | Date) =>
    new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
  const author = (id: string) =>
    authors[id] ?? (id.startsWith('agent') ? 'the agent' : 'a former member')

  async function view(rev: Revision, index: number) {
    error = null
    try {
      const r = await driveApi.revisionText(fileId, rev.id)
      viewing = { revision: r.revision, content: r.content, index }
      open = true
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }

  async function restore(id: string) {
    error = null
    busy = id
    try {
      await onrestore(id)
      open = false
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = null
    }
  }
</script>

<section class="flex flex-col gap-2" data-testid="drive-revisions">
  <h2 class="text-base font-semibold">Revisions</h2>
  {#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
  {#if revisions.length === 0}
    <p class="text-sm text-muted-foreground">No revisions yet.</p>
  {:else}
    <ul class="max-h-80 divide-y overflow-y-auto rounded-lg border text-sm">
      {#each revisions as rev, i (rev.id)}
        <li class="flex items-center gap-3 px-4 py-2" data-testid="drive-revision">
          <span class="flex-1">
            <span class="font-medium">{author(rev.authorId)}</span>
            <span class="text-muted-foreground">
              · {fmt(rev.createdAt)} · {formatSize(rev.size)}</span
            >
            {#if i === 0}<span class="ml-1 rounded-full border px-2 py-0.5 text-xs">current</span
              >{/if}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onclick={() => view(rev, i)}
            data-testid="drive-revision-view">View</Button
          >
          {#if i > 0 && canRestore}
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onclick={() => restore(rev.id)}
              data-testid="drive-revision-restore">Restore</Button
            >
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<Dialog.Root bind:open>
  <Dialog.Content
    class="max-h-[85vh] max-w-4xl overflow-y-auto"
    data-testid="drive-revision-dialog"
  >
    {#if viewing}
      <Dialog.Header>
        <Dialog.Title>{viewing.index === 0 ? 'Current version' : 'Earlier version'}</Dialog.Title>
        <Dialog.Description
          >{author(viewing.revision.authorId)} · {fmt(
            viewing.revision.createdAt,
          )}</Dialog.Description
        >
      </Dialog.Header>
      <div class="rounded-lg border" data-testid="drive-revision-content">
        {#key viewing.revision.id}
          {#if kind === 'markdown'}
            <MarkdownEditor content={viewing.content} editable={false} />
          {:else}
            <CsvEditor content={viewing.content} editable={false} />
          {/if}
        {/key}
      </div>
      {#if viewing.index > 0 && canRestore}
        <Dialog.Footer>
          <Button
            disabled={busy !== null}
            onclick={() => viewing && restore(viewing.revision.id)}
            data-testid="drive-revision-dialog-restore">Restore this version</Button
          >
        </Dialog.Footer>
      {/if}
    {/if}
  </Dialog.Content>
</Dialog.Root>
