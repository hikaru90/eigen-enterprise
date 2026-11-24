<script lang="ts">
  import type { PageProps } from './$types'
  import { enhance } from '$app/forms'
  import PageFrame from '$lib/components/page/page-frame.svelte'
  import PageHeader from '$lib/components/page/page-header.svelte'
  import { docTitle } from '$lib/shell/title'

  /**
   * Contribute → Modules (plan/phase-upgrades-u2.md §7): the module hub's
   * view for the owner — every module installs published, its versions, the
   * installs running it, its code and its summary. Everything here comes from
   * the module_hub.* tools (+page.server.ts); summarising again is the one
   * action (module_hub.summarize).
   */
  let { data, form }: PageProps = $props()

  const short = (sha: string) => sha.slice(0, 12)
  const day = (iso: string) => iso.slice(0, 10)
  const moduleHref = (installId: string, moduleId: string) =>
    `?install=${encodeURIComponent(installId)}&module=${encodeURIComponent(moduleId)}`
  const versionHref = (sha: string) =>
    data.detail ? `${moduleHref(data.detail.module.installId, data.detail.module.moduleId)}&sha=${sha}` : `?sha=${sha}`
  const fileHref = (sha: string, path: string) => `${versionHref(sha)}&path=${encodeURIComponent(path)}`
  const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`)
</script>

<svelte:head>
  <title>{docTitle('Modules')}</title>
</svelte:head>

<!-- eslint-disable svelte/no-navigation-without-resolve -- every link here is query-only (?q=, ?install=&module=, &sha=, &path=) on this same page -->

<PageFrame testid="contribute-modules">
  <PageHeader title="Modules" part="contribute">
    {#snippet info()}
      <p>Modules that eigenEnterprise installs built and published (Apache-2.0). The hub checks each bundle and signs a receipt; boxes run only receipted code.</p>
    {/snippet}
  </PageHeader>

  <div class="mt-6 grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
    <section aria-label="Published modules" class="min-w-0">
      <form method="GET" class="mb-3">
        <input
          name="q"
          value={data.query}
          placeholder="Find a module"
          class="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
        />
      </form>
      {#if data.list.modules.length === 0}
        <p class="text-sm text-foreground/60">No modules published yet.</p>
      {:else}
        <ul class="divide-y divide-border rounded-md border border-border" data-testid="hub-modules">
          {#each data.list.modules as m (m.installId + m.moduleId)}
            <li>
              <a href={moduleHref(m.installId, m.moduleId)} class="block px-3 py-2 hover:bg-foreground/5">
                <span class="font-medium">{m.name}</span>
                <span class="text-xs text-foreground/60">{m.moduleId}@{m.latestVersion}</span>
                <span class="block truncate text-xs text-foreground/60">{m.description}</span>
                <span class="text-xs text-foreground/60 tabular-nums">
                  install {m.installId.slice(0, 8)} · {m.versions} version{m.versions === 1 ? '' : 's'} · {day(m.lastPublishedAt)}
                </span>
              </a>
            </li>
          {/each}
        </ul>
        {#if data.list.cursor}
          <a class="mt-2 inline-block text-sm underline" href={`?q=${encodeURIComponent(data.query)}&cursor=${data.list.cursor}`}>More</a>
        {/if}
      {/if}
    </section>

    <section aria-label="Module" class="min-w-0 space-y-6">
      {#if data.detail}
        <div>
          <h2 class="text-lg font-semibold">{data.detail.module.name}</h2>
          <p class="text-sm text-foreground/70">{data.detail.module.description}</p>
        </div>

        <div>
          <h3 class="mb-2 text-sm font-semibold">Versions</h3>
          <ul class="space-y-1 text-sm" data-testid="hub-versions">
            {#each data.detail.versions as v (v.bundleSha256)}
              <li>
                <a href={versionHref(v.bundleSha256)} class="underline-offset-2 hover:underline" aria-current={data.version?.bundleSha256 === v.bundleSha256}>
                  {v.version} · {data.detail.module.moduleId}@{v.commit.slice(0, 12)}
                </a>
                <span class="text-xs text-foreground/60">{day(v.publishedAt)}</span>
              </li>
            {/each}
          </ul>
        </div>

        <div>
          <h3 class="mb-2 text-sm font-semibold">Installs running it</h3>
          {#if data.detail.runs.length === 0}
            <p class="text-sm text-foreground/60">No install has reported running it.</p>
          {:else}
            <ul class="space-y-1 text-sm tabular-nums" data-testid="hub-runs">
              {#each data.detail.runs as r (r.installId)}
                <li>install {r.installId.slice(0, 8)} · {r.version} ({short(r.bundleSha256)}) · {r.state} · {day(r.reportedAt)}</li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}

      {#if data.version}
        <div>
          <h3 class="mb-2 text-sm font-semibold">Summary of {data.version.version}</h3>
          {#if data.version.summary}
            <dl class="space-y-2 text-sm" data-testid="hub-summary">
              <dt class="font-medium">What it does</dt>
              <dd class="text-foreground/80">{data.version.summary.does}</dd>
              <dt class="font-medium">What it touches</dt>
              <dd class="text-foreground/80">{data.version.summary.touches}</dd>
              <dt class="font-medium">What it sends out</dt>
              <dd class="text-foreground/80">{data.version.summary.sendsOut}</dd>
            </dl>
          {:else}
            <p class="text-sm text-foreground/60">Not summarised yet.</p>
          {/if}
          {#if data.canSummarize}
            <form method="POST" action="?/summarize" use:enhance class="mt-2">
              <input type="hidden" name="bundle_sha256" value={data.version.bundleSha256} />
              <button class="rounded-md border border-border px-3 py-1 text-sm hover:bg-foreground/5">Summarise again</button>
            </form>
          {/if}
          {#if form?.error}
            <p class="mt-2 text-sm text-destructive" role="alert">{form.error}</p>
          {/if}
        </div>

        <div>
          <h3 class="mb-2 text-sm font-semibold">Reach</h3>
          <p class="text-sm">
            Uses: {[...((data.version.uses.tools as string[]) ?? []), ...((data.version.uses.events as string[]) ?? [])].join(', ') || 'nothing'}
          </p>
          {#if data.version.deprecatedUses.length}
            <p class="text-sm text-foreground/70">Deprecated uses: {data.version.deprecatedUses.join(', ')}</p>
          {/if}
          <p class="text-xs text-foreground/60 tabular-nums">
            bundle {short(data.version.bundleSha256)} · {kb(data.version.bytes)} · {data.version.files} files · core-api {data.version.coreApi} · receipt key {data.version.receipt.keyId}
          </p>
        </div>

        <div>
          <h3 class="mb-2 text-sm font-semibold">Code</h3>
          <ul class="grid gap-x-4 text-sm sm:grid-cols-2" data-testid="hub-files">
            {#each data.files as f (f.path)}
              <li class="truncate">
                <a href={fileHref(data.version.bundleSha256, f.path)} class="font-mono text-xs hover:underline">{f.path}</a>
                <span class="text-xs text-foreground/60">{kb(f.size)}</span>
              </li>
            {/each}
          </ul>
          {#if data.file}
            <div class="mt-3">
              <p class="mb-1 font-mono text-xs">{data.file.path}</p>
              {#if data.file.binary}
                <p class="text-sm text-foreground/60">A binary file ({kb(data.file.size)}).</p>
              {:else}
                <pre class="max-h-[32rem] overflow-auto rounded-md border border-border bg-foreground/5 p-3 text-xs" data-testid="hub-file">{data.file.content}</pre>
                {#if data.file.truncated}
                  <p class="text-xs text-foreground/60">Cut at 256 KB of {kb(data.file.size)}.</p>
                {/if}
              {/if}
            </div>
          {/if}
        </div>
      {:else if !data.detail}
        <p class="text-sm text-foreground/60">Pick a module to read its versions, code and summary.</p>
      {/if}
    </section>
  </div>
</PageFrame>
