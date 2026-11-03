<script lang="ts">
  import type { PageData } from './$types'
  import DownloadIcon from '@lucide/svelte/icons/download'
  import FileIcon from '@lucide/svelte/icons/file'
  import { invalidateAll } from '$app/navigation'
  import { resolve } from '$app/paths'
  import DocEditor from '$lib/components/drive/doc-editor.svelte'
  import RevisionsPanel from '$lib/components/drive/revisions-panel.svelte'
  import SectionHeader from '$lib/components/page/section-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { driveApi, formatSize } from '$lib/drive/api'
  import { docTitle } from '$lib/shell/title'

  /**
   * Open a file: the in-place editor for Markdown/CSV when the viewer may
   * edit (D2), else the preview; download; the revisions of Markdown/CSV.
   */
  let { data }: { data: PageData } = $props()
  const contentUrl = $derived(`/api/drive/files/${data.file.id}/content`)
  const fmt = (d: string | Date) => new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const revisioned = $derived(data.kind === 'markdown' || data.kind === 'csv')
  /** Size and changed time as of the latest save (the load's copy goes stale while editing). */
  let saved = $state<{ id: string; size?: number; updatedAt: string | Date } | null>(null)
  const meta = $derived(saved && saved.id === data.file.id ? saved : data.file)
  const iso = (d: string | Date) => new Date(d).toISOString()
  const revisions = $derived(
    data.revisions.map((r) => ({ ...r, createdAt: iso(r.createdAt), restoredFrom: r.restoredFrom ? { ...r.restoredFrom, createdAt: iso(r.restoredFrom.createdAt) } : undefined })),
  )

  async function restore(revisionId: string) {
    await driveApi.restoreRevision(data.file.id, revisionId)
    await invalidateAll()
  }
</script>

<svelte:head><title>{docTitle(data.file.name, 'Drive')}</title></svelte:head>

<div class="mt-6 flex flex-col gap-4" data-testid="drive-file">
  <nav aria-label="Folder path" class="flex flex-wrap items-center gap-1 text-sm" data-testid="drive-path">
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- server-given app path ('/drive', '/drive/shared', '/messages') -->
    <a href={data.root.href} class="text-muted-foreground hover:text-foreground" data-testid="drive-path-root">{data.root.label}</a>
    {#each data.path as crumb (crumb.id)}
      <span class="text-muted-foreground">/</span>
      <a href={resolve(`/drive/folder/${crumb.id}`)} class="text-muted-foreground hover:text-foreground">{crumb.name}</a>
    {/each}
  </nav>

  <SectionHeader title={data.file.name} description={`${formatSize(meta.size)} · changed ${fmt(meta.updatedAt)}${data.canEdit ? '' : ' · view only'}`}>
    {#snippet actions()}
      <Button variant="outline" href={`${contentUrl}?download=1`} download data-testid="drive-file-download"><DownloadIcon class="size-4" /> Download</Button>
    {/snippet}
  </SectionHeader>

  {#if data.editable && data.content !== null && (data.kind === 'markdown' || data.kind === 'csv')}
    {#key data.file.id}
      <DocEditor fileId={data.file.id} kind={data.kind} content={data.content} {revisions} authors={data.authors} heartbeatMs={data.heartbeatMs} onsaved={(f) => (saved = f)} />
    {/key}
  {:else}
  <div class="rounded-lg border" data-testid="drive-preview" data-kind={data.kind}>
    {#if data.kind === 'markdown'}
      {#if data.html}
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized server side (renderDriveMarkdown: marked + DOMPurify) -->
        <article class="drive-markdown max-w-3xl px-6 py-5 text-sm leading-relaxed" data-testid="drive-markdown">{@html data.html}</article>
      {:else}
        <p class="px-6 py-8 text-sm text-muted-foreground">This document is empty.</p>
      {/if}
    {:else if data.kind === 'csv' && data.table}
      {#if data.table.rows.length === 0}
        <p class="px-6 py-8 text-sm text-muted-foreground">This table is empty.</p>
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-sm" data-testid="drive-csv">
            <thead>
              <tr class="border-b bg-muted/40">
                {#each data.table.rows[0] ?? [] as cell, i (i)}<th class="px-3 py-2 text-left font-medium">{cell}</th>{/each}
              </tr>
            </thead>
            <tbody>
              {#each data.table.rows.slice(1) as row, r (r)}
                <tr class="border-b last:border-0">
                  {#each row as cell, c (c)}<td class="px-3 py-1.5">{cell}</td>{/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if data.table.truncated}<p class="px-3 py-2 text-xs text-muted-foreground">Showing the first rows; download for the whole table.</p>{/if}
      {/if}
    {:else if data.kind === 'image'}
      <div class="flex justify-center bg-muted/30 p-4">
        <img src={contentUrl} alt={data.file.name} class="max-h-[70vh] max-w-full object-contain" data-testid="drive-image" />
      </div>
    {:else if data.kind === 'pdf'}
      <iframe src={contentUrl} title={data.file.name} class="h-[75vh] w-full rounded-lg" data-testid="drive-pdf"></iframe>
    {:else if data.kind === 'text'}
      <pre class="max-h-[70vh] overflow-auto px-6 py-5 text-sm whitespace-pre-wrap" data-testid="drive-text">{data.text}</pre>
    {:else}
      <div class="flex flex-col items-center gap-3 px-6 py-12 text-sm text-muted-foreground" data-testid="drive-no-preview">
        <FileIcon class="size-10" />
        <p>No preview for this kind of file.</p>
        <Button variant="outline" href={`${contentUrl}?download=1`} download><DownloadIcon class="size-4" /> Download</Button>
      </div>
    {/if}
  </div>

  {#if revisioned}
    <RevisionsPanel fileId={data.file.id} kind={data.kind === 'csv' ? 'csv' : 'markdown'} {revisions} authors={data.authors} canRestore={false} onrestore={restore} />
  {/if}
  {/if}
</div>

<style>
  /* Rendered Markdown (no typography plugin in this app): plain, readable defaults. */
  .drive-markdown :global(h1) { font-size: 1.5rem; font-weight: 600; margin: 0.25rem 0 0.75rem; }
  .drive-markdown :global(h2) { font-size: 1.25rem; font-weight: 600; margin: 1.25rem 0 0.5rem; }
  .drive-markdown :global(h3) { font-size: 1.05rem; font-weight: 600; margin: 1rem 0 0.5rem; }
  .drive-markdown :global(p) { margin: 0.5rem 0; }
  .drive-markdown :global(ul) { list-style: disc; padding-left: 1.5rem; margin: 0.5rem 0; }
  .drive-markdown :global(ol) { list-style: decimal; padding-left: 1.5rem; margin: 0.5rem 0; }
  .drive-markdown :global(a) { text-decoration: underline; }
  .drive-markdown :global(code) { font-family: ui-monospace, monospace; font-size: 0.85em; background: var(--muted); padding: 0.1rem 0.3rem; border-radius: 0.25rem; }
  .drive-markdown :global(pre) { background: var(--muted); padding: 0.75rem; border-radius: 0.375rem; overflow-x: auto; }
  .drive-markdown :global(blockquote) { border-left: 3px solid var(--border); padding-left: 0.75rem; color: var(--muted-foreground); }
  .drive-markdown :global(table) { border-collapse: collapse; margin: 0.75rem 0; }
  .drive-markdown :global(th), .drive-markdown :global(td) { border: 1px solid var(--border); padding: 0.25rem 0.5rem; text-align: left; }
  .drive-markdown :global(img) { max-width: 100%; }
</style>
