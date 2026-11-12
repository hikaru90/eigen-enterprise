<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- the path root is a server-given app path ('/drive', '/drive/shared', '/messages') */
  /* eslint-disable svelte/no-at-html-tags -- data.html is sanitized server side (renderDriveMarkdown: marked + DOMPurify) */
  import type { PageData } from './$types'
  import ArchiveIcon from '@lucide/svelte/icons/archive'
  import DownloadIcon from '@lucide/svelte/icons/download'
  import FileIcon from '@lucide/svelte/icons/file'
  import LockIcon from '@lucide/svelte/icons/lock'
  import Share2Icon from '@lucide/svelte/icons/share-2'
  import UsersIcon from '@lucide/svelte/icons/users'
  import { invalidateAll } from '$app/navigation'
  import { resolve } from '$app/paths'
  import ArchiveBanner from '$lib/components/drive/archive-banner.svelte'
  import DocEditor from '$lib/components/drive/doc-editor.svelte'
  import RevisionsPanel from '$lib/components/drive/revisions-panel.svelte'
  import ShareDialog from '$lib/components/drive/share-dialog.svelte'
  import { Button } from '$lib/components/ui/button'
  import { driveApi, formatSize } from '$lib/drive/api'
  import { driveItemKind, initialsOf } from '$lib/drive/display'
  import { docTitle } from '$lib/shell/title'

  /**
   * Open a file, full width (P-3): the path and the file's name across the
   * top; the in-place editor for Markdown/CSV when the viewer may edit (D2),
   * else the preview, filling the space; beside it a panel with the details,
   * sharing and — for Markdown/CSV — the revisions.
   */
  let { data }: { data: PageData } = $props()
  const contentUrl = $derived(`/api/drive/files/${data.file.id}/content`)
  const fmt = (d: string | Date) =>
    new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const revisioned = $derived(data.kind === 'markdown' || data.kind === 'csv')
  /** Size and changed time as of the latest save (the load's copy goes stale while editing). */
  let saved = $state<{ id: string; size?: number; updatedAt: string | Date } | null>(null)
  const meta = $derived(saved && saved.id === data.file.id ? saved : data.file)
  const iso = (d: string | Date) => new Date(d).toISOString()
  const revisions = $derived(
    data.revisions.map((r) => ({
      ...r,
      createdAt: iso(r.createdAt),
      restoredFrom: r.restoredFrom
        ? { ...r.restoredFrom, createdAt: iso(r.restoredFrom.createdAt) }
        : undefined,
    })),
  )
  const KIND_LABEL = {
    folder: 'Folder',
    document: 'Document',
    table: 'Table',
    image: 'Image',
    pdf: 'PDF',
    file: 'File',
  } as const
  const kindLabel = $derived(KIND_LABEL[driveItemKind(data.file)])
  let sharing = $state(false)

  async function restore(revisionId: string) {
    await driveApi.restoreRevision(data.file.id, revisionId)
    await invalidateAll()
  }

  let archiving = $state(false)
  let archiveError = $state<string | null>(null)
  async function archive() {
    archiveError = null
    archiving = true
    try {
      await driveApi.archive(data.file)
      await invalidateAll()
    } catch (err) {
      archiveError = err instanceof Error ? err.message : String(err)
    } finally {
      archiving = false
    }
  }
</script>

<svelte:head><title>{docTitle(data.file.name, 'Drive')}</title></svelte:head>

{#snippet details()}
  <section class="flex flex-col gap-3" data-testid="drive-file-details">
    <h2 class="text-base font-semibold">Details</h2>
    <dl class="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
      <dt class="text-muted-foreground">Type</dt>
      <dd>{kindLabel}{data.file.mime ? ` · ${data.file.mime}` : ''}</dd>
      <dt class="text-muted-foreground">Size</dt>
      <dd class="tabular-nums">{formatSize(meta.size)}</dd>
      <dt class="text-muted-foreground">Changed</dt>
      <dd>{fmt(meta.updatedAt)}</dd>
      <dt class="text-muted-foreground">Owner</dt>
      <dd>
        {#if data.described.ownerName}
          <span class="flex min-w-0 items-center gap-2">
            <span
              class="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium"
              aria-hidden="true">{initialsOf(data.described.ownerName)}</span
            >
            <span class="truncate">{data.described.ownerName}</span>
          </span>
        {:else}
          —
        {/if}
      </dd>
      <dt class="text-muted-foreground">Your access</dt>
      <dd>{data.canManage ? 'Can manage' : data.canEdit ? 'Can edit' : 'Can view'}</dd>
    </dl>
  </section>
  <section class="flex flex-col gap-2" data-testid="drive-file-sharing">
    <h2 class="text-base font-semibold">Sharing</h2>
    {#if data.described.shared === null}
      <p class="text-sm text-muted-foreground">Whoever manages this file decides who can see it.</p>
    {:else}
      <p class="flex items-center gap-2 text-sm text-muted-foreground">
        <UsersIcon class="size-4" aria-hidden="true" />
        {data.described.readOnlyFrom
          ? `Comes from ${data.described.readOnlyFrom}: the whole company can open it unless sharing was narrowed.`
          : data.described.shared
            ? 'Shared with others.'
            : 'Only you (and admins) can open it.'}
      </p>
      <Button
        variant="outline"
        size="sm"
        class="self-start"
        onclick={() => (sharing = true)}
        data-testid="drive-file-share"
      >
        <Share2Icon class="size-4" aria-hidden="true" /> Share…
      </Button>
    {/if}
  </section>
{/snippet}

<div class="flex min-h-0 flex-1 flex-col" data-testid="drive-file">
  <header
    class="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-6"
  >
    <div class="min-w-0">
      <nav
        aria-label="Folder path"
        class="flex flex-wrap items-center gap-1 text-sm"
        data-testid="drive-path"
      >
        <a
          href={data.root.href}
          class="text-muted-foreground hover:text-foreground"
          data-testid="drive-path-root">{data.root.label}</a
        >
        {#each data.path as crumb (crumb.id)}
          <span class="text-muted-foreground/60">/</span>
          <a
            href={resolve(`/drive/folder/${crumb.id}`)}
            class="text-muted-foreground hover:text-foreground">{crumb.name}</a
          >
        {/each}
      </nav>
      <h2 class="mt-0.5 flex min-w-0 items-center gap-2 text-lg font-semibold">
        <span class="truncate">{data.file.name}</span>
        {#if data.described.readOnlyFrom}
          <span
            class="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 py-px text-[10px] font-normal text-muted-foreground"
            title={`Comes from ${data.described.readOnlyFrom}; change it there`}
            data-testid="drive-readonly-badge"
          >
            <LockIcon class="size-3" aria-hidden="true" />
            {data.described.readOnlyFrom} · read-only
          </span>
        {/if}
      </h2>
      <p class="text-sm text-muted-foreground" data-testid="drive-file-meta">
        {`${formatSize(meta.size)} · changed ${fmt(meta.updatedAt)}${data.canEdit ? '' : ' · view only'}`}
      </p>
    </div>
    <div class="flex items-center gap-2">
      {#if data.canEdit && !data.file.archivedAt}
        <Button
          variant="outline"
          onclick={archive}
          disabled={archiving}
          title="Hide it from the everyday view; it stays here, opens and shows up in search"
          data-testid="drive-file-archive"><ArchiveIcon class="size-4" /> Archive</Button
        >
      {/if}
      <Button
        variant="outline"
        href={`${contentUrl}?download=1`}
        download
        data-testid="drive-file-download"><DownloadIcon class="size-4" /> Download</Button
      >
    </div>
  </header>
  {#if archiveError}
    <p
      class="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive sm:px-6"
      role="alert"
    >
      {archiveError}
    </p>
  {/if}
  <ArchiveBanner item={data.file} archivedIn={data.archivedIn} canEdit={data.canEdit} />

  <div class="flex min-h-0 flex-1 flex-col px-4 py-4 sm:px-6">
    {#if data.editable && data.content !== null && (data.kind === 'markdown' || data.kind === 'csv')}
      {#key data.file.id}
        <DocEditor
          fileId={data.file.id}
          kind={data.kind}
          content={data.content}
          {revisions}
          authors={data.authors}
          heartbeatMs={data.heartbeatMs}
          onsaved={(f) => (saved = f)}
          side={details}
        />
      {/key}
    {:else}
      <div class="grid min-h-0 flex-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div
          class="flex min-h-[60vh] min-w-0 flex-col overflow-hidden rounded-lg border bg-card"
          data-testid="drive-preview"
          data-kind={data.kind}
        >
          {#if data.kind === 'markdown'}
            {#if data.html}
              <article
                class="drive-markdown max-w-3xl px-6 py-5 text-sm leading-relaxed"
                data-testid="drive-markdown"
              >
                {@html data.html}
              </article>
            {:else}
              <p class="px-6 py-8 text-sm text-muted-foreground">This document is empty.</p>
            {/if}
          {:else if data.kind === 'csv' && data.table}
            {#if data.table.rows.length === 0}
              <p class="px-6 py-8 text-sm text-muted-foreground">This table is empty.</p>
            {:else}
              <div class="overflow-auto">
                <table class="w-full text-sm" data-testid="drive-csv">
                  <thead>
                    <tr class="border-b bg-muted/40">
                      {#each data.table.rows[0] ?? [] as cell, i (i)}<th
                          class="px-3 py-2 text-left font-medium">{cell}</th
                        >{/each}
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
              {#if data.table.truncated}<p class="px-3 py-2 text-xs text-muted-foreground">
                  Showing the first rows; download for the whole table.
                </p>{/if}
            {/if}
          {:else if data.kind === 'image'}
            <div class="flex flex-1 items-center justify-center bg-muted/30 p-4">
              <img
                src={contentUrl}
                alt={data.file.name}
                class="max-h-[75vh] max-w-full object-contain"
                data-testid="drive-image"
              />
            </div>
          {:else if data.kind === 'pdf'}
            <iframe
              src={contentUrl}
              title={data.file.name}
              class="min-h-[75vh] w-full flex-1"
              data-testid="drive-pdf"
            ></iframe>
          {:else if data.kind === 'text'}
            <pre
              class="flex-1 overflow-auto px-6 py-5 text-sm whitespace-pre-wrap"
              data-testid="drive-text">{data.text}</pre>
          {:else}
            <div
              class="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-sm text-muted-foreground"
              data-testid="drive-no-preview"
            >
              <FileIcon class="size-10" />
              <p>No preview for this kind of file.</p>
              <Button variant="outline" href={`${contentUrl}?download=1`} download
                ><DownloadIcon class="size-4" /> Download</Button
              >
            </div>
          {/if}
        </div>
        <aside class="flex min-w-0 flex-col gap-6" data-testid="drive-file-side">
          {@render details()}
          {#if revisioned}
            <RevisionsPanel
              fileId={data.file.id}
              kind={data.kind === 'csv' ? 'csv' : 'markdown'}
              {revisions}
              authors={data.authors}
              canRestore={false}
              onrestore={restore}
            />
          {/if}
        </aside>
      </div>
    {/if}
  </div>
</div>

{#if sharing}
  <ShareDialog item={data.file} onclose={() => (sharing = false)} />
{/if}

<style>
  /* Rendered Markdown (no typography plugin in this app): plain, readable defaults. */
  .drive-markdown :global(h1) {
    font-size: 1.5rem;
    font-weight: 600;
    margin: 0.25rem 0 0.75rem;
  }
  .drive-markdown :global(h2) {
    font-size: 1.25rem;
    font-weight: 600;
    margin: 1.25rem 0 0.5rem;
  }
  .drive-markdown :global(h3) {
    font-size: 1.05rem;
    font-weight: 600;
    margin: 1rem 0 0.5rem;
  }
  .drive-markdown :global(p) {
    margin: 0.5rem 0;
  }
  .drive-markdown :global(ul) {
    list-style: disc;
    padding-left: 1.5rem;
    margin: 0.5rem 0;
  }
  .drive-markdown :global(ol) {
    list-style: decimal;
    padding-left: 1.5rem;
    margin: 0.5rem 0;
  }
  .drive-markdown :global(a) {
    text-decoration: underline;
  }
  .drive-markdown :global(code) {
    font-family: ui-monospace, monospace;
    font-size: 0.85em;
    background: var(--muted);
    padding: 0.1rem 0.3rem;
    border-radius: 0.25rem;
  }
  .drive-markdown :global(pre) {
    background: var(--muted);
    padding: 0.75rem;
    border-radius: 0.375rem;
    overflow-x: auto;
  }
  .drive-markdown :global(blockquote) {
    border-left: 3px solid var(--border);
    padding-left: 0.75rem;
    color: var(--muted-foreground);
  }
  .drive-markdown :global(table) {
    border-collapse: collapse;
    margin: 0.75rem 0;
  }
  .drive-markdown :global(th),
  .drive-markdown :global(td) {
    border: 1px solid var(--border);
    padding: 0.25rem 0.5rem;
    text-align: left;
  }
  .drive-markdown :global(img) {
    max-width: 100%;
  }
</style>
