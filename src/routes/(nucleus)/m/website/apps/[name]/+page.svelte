<script lang="ts">
  import type { ActionData, PageData } from './$types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import AppStatusDot from '$lib/components/app-status-dot.svelte'

  let { data, form }: { data: PageData; form: ActionData } = $props()
  let busy = $state<'deploy' | 'env' | 'remove' | null>(null)

  const track = (what: 'deploy' | 'env' | 'remove') => () => {
    busy = what
    return async ({ update }: { update: () => Promise<void> }) => {
      await update()
      busy = null
    }
  }

  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never')
</script>

<svelte:head><title>{data.app.name} · Apps · Eigen Enterprise</title></svelte:head>

<div class="mx-auto w-full max-w-4xl px-4 pt-6 pb-16 sm:px-8 sm:pt-10">
  <header class="flex min-w-0 flex-col gap-1.5 border-b border-border pb-6">
    <a href={resolve('/m/website/apps')} class="text-xs text-foreground/55 hover:text-foreground"
      >Apps</a
    >
    <h1 class="flex items-center gap-3 text-xl font-semibold tracking-tight">
      {data.app.name}
      <AppStatusDot status={data.app.status} />
    </h1>
    <p class="text-sm break-words text-foreground/60">
      {data.app.kind === 'web' ? 'Web app' : 'Back-end service'} from {data.app.repo} · {data.app
        .branch}{data.app.shortSha ? `@${data.app.shortSha}` : ''} · last deploy {when(
        data.app.lastDeployedAt,
      )}
    </p>
    {#if data.app.url}
      <a
        href={data.app.url}
        class="text-sm break-all underline"
        rel="external noopener noreferrer"
        target="_blank">{data.app.url}</a
      >
    {/if}
    {#if data.app.lastError}
      <p class="text-sm text-red-600" role="alert">{data.app.lastError}</p>
    {/if}
  </header>

  <section class="mt-6 flex flex-wrap items-center gap-3">
    <form method="POST" action="?/deploy" use:enhance={track('deploy')}>
      <button
        type="submit"
        disabled={busy !== null}
        class="rounded-md bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-60"
      >
        {busy === 'deploy' ? 'Deploying… this can take a few minutes' : 'Deploy now'}
      </button>
    </form>
    <span class="text-xs text-foreground/55">
      {data.app.autoDeploy
        ? 'Also deploys on every push to this branch.'
        : data.app.authKind === 'github_app'
          ? 'Deployed by hand.'
          : 'Deployed by hand: repos read by deploy key or public link get no push events.'}
      Build contract: {data.app.contractSource === 'repo'
        ? "the repo's ee.json"
        : 'the build form'}.
    </span>
  </section>
  {#if form && 'error' in form && form.error}
    <p class="mt-3 text-sm text-red-600" role="alert">{form.error}</p>
  {:else if form && 'message' in form}
    <p class="mt-3 text-sm text-foreground/70" role="status">{form.message}</p>
  {/if}

  <section class="mt-8 flex flex-col gap-2" aria-label="Domains">
    <h2 class="text-base font-semibold">Domains</h2>
    {#if data.app.domains.length === 0}
      <p class="text-sm text-foreground/60">No public address (back-end service).</p>
    {/if}
    {#each data.app.domains as d (d)}
      <p class="text-sm break-all">{d}</p>
    {/each}
  </section>

  <section class="mt-8 flex flex-col gap-3" aria-label="Environment variables">
    <h2 class="text-base font-semibold">Environment variables</h2>
    {#if data.app.env.length === 0}
      <p class="text-sm text-foreground/60">None yet.</p>
    {/if}
    <ul class="flex flex-col gap-1">
      {#each data.app.env as key (key)}
        <li class="flex items-center gap-2 font-mono text-xs">
          {key} <span class="text-foreground/40">••••••••</span>
        </li>
      {/each}
    </ul>
    <form
      method="POST"
      action="?/env"
      use:enhance={track('env')}
      class="flex flex-col gap-2 sm:flex-row"
      autocomplete="off"
    >
      <input
        name="key"
        required
        placeholder="NAME"
        class="rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs"
      />
      <input
        name="value"
        type="password"
        required
        placeholder="value (stored sealed, never shown again)"
        class="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs"
      />
      <button
        type="submit"
        disabled={busy !== null}
        class="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-60"
        >{busy === 'env' ? 'Saving…' : 'Set'}</button
      >
    </form>
  </section>

  <section class="mt-8 flex flex-col gap-2" aria-label="Deploy history">
    <h2 class="text-base font-semibold">Deploy history</h2>
    {#if data.app.history.length === 0}
      <p class="text-sm text-foreground/60">No deploys yet.</p>
    {/if}
    <ul class="flex flex-col gap-1">
      {#each data.app.history.slice(0, 30) as e, i (i)}
        <li class="text-xs break-words text-foreground/70">
          <span class="text-foreground/45">{when(e.time)}</span> · {e.message}
        </li>
      {/each}
    </ul>
  </section>

  <section class="mt-8 flex flex-col gap-2" aria-label="Logs">
    <h2 class="text-base font-semibold">Recent logs</h2>
    {#if data.logsError}
      <p class="text-sm text-foreground/60">{data.logsError}</p>
    {:else}
      <pre
        class="max-h-96 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs whitespace-pre-wrap">{data.logs.join(
          '\n',
        )}</pre>
    {/if}
  </section>

  <section class="mt-10 border-t border-border pt-6">
    <form method="POST" action="?/remove" use:enhance={track('remove')}>
      <button
        type="submit"
        disabled={busy !== null}
        class="rounded-md border border-red-500/60 px-3 py-1.5 text-sm text-red-600 disabled:opacity-60"
        >{busy === 'remove' ? 'Removing…' : 'Remove this app from the server'}</button
      >
    </form>
  </section>
</div>
