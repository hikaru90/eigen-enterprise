<script lang="ts">
  import type { PageProps } from './$types'
  import { onMount } from 'svelte'
  import { enhance } from '$app/forms'
  import { invalidateAll } from '$app/navigation'
  import { resolve } from '$app/paths'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { shownErrorOf } from '$lib/errors/agent-report'
  import type { CompanyExportView } from '$lib/kernel/export-tools'
  import { docTitle } from '$lib/shell/title'

  let { data, form }: PageProps = $props()

  const error = $derived(shownErrorOf(form))
  const building = $derived(data.exports.some((e) => e.status === 'pending' || e.status === 'running'))
  let busy = $state(false)

  const primary =
    'h-9 bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50'
  const secondary =
    'inline-flex h-9 items-center border border-border px-3 text-xs hover:border-primary disabled:cursor-not-allowed disabled:opacity-50'

  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '')
  const size = (bytes: number | null) => {
    if (bytes === null) return ''
    const units = ['B', 'KB', 'MB', 'GB']
    let n = bytes
    let i = 0
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024
      i++
    }
    return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
  }
  const STATUS: Record<CompanyExportView['status'], string> = {
    pending: 'Waiting to start (within a minute)',
    running: 'Being built',
    done: 'Ready',
    failed: 'Failed',
    deleted: 'Deleted',
  }

  // While one is being built, look again every few seconds (stops on its own when it is done).
  onMount(() => {
    const timer = setInterval(() => {
      if (building) void invalidateAll()
    }, 3000)
    return () => clearInterval(timer)
  })
</script>

<svelte:head>
  <title>{docTitle('Export', 'Settings')}</title>
</svelte:head>

<h2 class="text-base font-semibold tracking-tight">Export</h2>
<p class="mt-2 max-w-prose text-sm text-foreground/70">
  Everything the company owns, as one zip in open formats: every table as JSON Lines, every company file
  in its folder, a README that explains it all and a manifest with a checksum for every file. You need no
  eigenEnterprise to read it.
</p>
<p class="mt-2 max-w-prose text-xs text-foreground/60">
  A member’s private items (their DMs, personal mailbox, private Memory, calendar details) are in it as
  metadata only: whose, when, with whom, never what they say.
  Keys and passwords are never exported; the README lists what to connect again.
</p>

{#if error}
  <div class="mt-4"><ErrorNotice error={error.error} agent={error.agent} /></div>
{/if}

<form
  method="POST"
  action="?/start"
  class="mt-6"
  use:enhance={() => {
    busy = true
    return async ({ update }) => {
      await update()
      busy = false
    }
  }}
>
  <button class={primary} type="submit" disabled={busy || building} data-testid="export-start">
    {building ? 'An export is being built…' : 'Export everything'}
  </button>
</form>

<section class="mt-8" aria-labelledby="export-history">
  <h3 id="export-history" class="text-sm font-semibold">Exports</h3>
  {#if data.exports.length === 0}
    <p class="mt-2 text-xs text-foreground/60">No export yet.</p>
  {:else}
    <ul class="mt-3 space-y-3" data-testid="export-list">
      {#each data.exports as e (e.id)}
        <li class="rounded-lg border border-border px-4 py-3 text-sm" data-status={e.status}>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p class="font-medium">{STATUS[e.status]}</p>
              <p class="text-xs text-foreground/60">
                Started {when(e.createdAt)}{#if e.finishedAt}, finished {when(e.finishedAt)}{/if}
                {#if e.bytes !== null}· {size(e.bytes)}{/if}
              </p>
              {#if e.summary}
                <p class="text-xs text-foreground/60">
                  {e.summary.tables} tables, {e.summary.rows} rows ({e.summary.privateRows} private, as metadata),
                  {e.summary.files} files; {e.summary.excluded} left out on purpose (listed in the README).
                </p>
              {/if}
              {#if e.status === 'done' && e.expiresAt}
                <p class="text-xs text-foreground/60">Kept on the server until {when(e.expiresAt)}.</p>
              {/if}
              {#if e.error}
                <p class="mt-1 text-xs text-red-700" role="alert">{e.error}</p>
              {/if}
            </div>
            <div class="flex gap-2">
              {#if e.downloadPath}
                <a
                  class={secondary}
                  href={resolve('/api/exports/[id]/download', { id: e.id })}
                  download
                  data-sveltekit-reload
                  data-testid="export-download">Download</a
                >
              {/if}
              {#if e.status === 'done' || e.status === 'failed'}
                <form method="POST" action="?/delete" use:enhance>
                  <input type="hidden" name="id" value={e.id} />
                  <button class={secondary} type="submit">Delete</button>
                </form>
              {/if}
            </div>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>
