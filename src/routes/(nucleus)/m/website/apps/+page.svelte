<script lang="ts">
  import type { ActionData, PageData } from './$types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import AppBuildForm from '$lib/components/app-build-form.svelte'
  import AppStatusDot from '$lib/components/app-status-dot.svelte'

  let { data, form }: { data: PageData; form: ActionData } = $props()
  let deploying = $state(false)
  let source = $state('')
  let name = $state('')
  let kind = $state<'web' | 'backend'>('web')
  // What "Let AI fill this out" reads: the picked repo + branch, keyed on the app name.
  const buildTarget = $derived.by(() => {
    const [repo, branch] = source.split('#')
    return repo && branch && name ? { name, repo, branch } : null
  })

  function pickSource(value: string) {
    source = value
    const repo = data.repos.find((r) => `${r.fullName}#${r.branch}` === value)
    if (repo) name = repo.suggestedName
  }

  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never')
</script>

<svelte:head><title>Apps · Website · Eigen Enterprise</title></svelte:head>

<div class="mx-auto w-full max-w-4xl px-4 pt-6 pb-16 sm:px-8 sm:pt-10">
  <header class="flex min-w-0 flex-col gap-1.5 border-b border-border pb-6">
    <a href={resolve('/m/website')} class="text-xs text-foreground/55 hover:text-foreground"
      >Website</a
    >
    <h1 class="text-xl font-semibold tracking-tight">Apps</h1>
    <p class="text-sm text-foreground/60">
      Web apps and back-end services built from your connected GitHub repos, running on this server.
    </p>
  </header>

  {#if data.error}
    <p class="mt-6 rounded-md border border-border bg-muted/40 p-3 text-sm" role="alert">
      {data.error}
    </p>
  {/if}

  <section class="mt-6 flex flex-col gap-2" aria-label="Services">
    {#if data.services.length === 0 && !data.error}
      <p class="text-sm text-foreground/60">Nothing deployed yet.</p>
    {/if}
    {#each data.services as s (s.name)}
      <a
        href={resolve(`/m/website/apps/${s.name}`)}
        class="flex flex-col gap-1 rounded-md border border-border p-3 hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between"
      >
        <div class="flex min-w-0 flex-col gap-0.5">
          <span class="flex items-center gap-2 text-sm font-medium">
            {s.name}
            <span class="text-xs font-normal text-foreground/50"
              >{s.kind === 'web' ? 'Web app' : 'Back-end service'}</span
            >
          </span>
          <span class="truncate text-xs text-foreground/60">
            {s.repo} · {s.branch}{s.shortSha ? `@${s.shortSha}` : ''} · last deploy {when(
              s.lastDeployedAt,
            )}
          </span>
          {#if s.url}<span class="truncate text-xs text-foreground/70">{s.url}</span>{/if}
        </div>
        <AppStatusDot status={s.status} />
      </a>
    {/each}
  </section>

  <section class="mt-10 flex flex-col gap-4" aria-label="Deploy a repo">
    <h2 class="text-base font-semibold">Deploy a repo</h2>
    {#if data.repos.length === 0}
      <p class="text-sm text-foreground/60">
        Connect a repo first under <a class="underline" href={resolve('/m/website/github')}
          >GitHub</a
        >.
      </p>
    {:else}
      <form
        method="POST"
        action="?/deploy"
        class="flex flex-col gap-4"
        use:enhance={() => {
          deploying = true
          return async ({ update }) => {
            await update()
            deploying = false
          }
        }}
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-sm">
            Repo and branch
            <select
              name="source"
              required
              value={source}
              onchange={(e) => pickSource(e.currentTarget.value)}
              class="rounded-md border border-border bg-background px-2 py-1.5"
            >
              <option value="" disabled>Pick a connected repo</option>
              {#each data.repos as r (`${r.fullName}#${r.branch}`)}
                <option value={`${r.fullName}#${r.branch}`}>{r.fullName} ({r.branch})</option>
              {/each}
            </select>
          </label>
          <label class="flex flex-col gap-1 text-sm">
            App name
            <input
              name="name"
              required
              bind:value={name}
              class="rounded-md border border-border bg-background px-2 py-1.5"
            />
          </label>
          <label class="flex flex-col gap-1 text-sm">
            Kind
            <select
              name="kind"
              bind:value={kind}
              class="rounded-md border border-border bg-background px-2 py-1.5"
            >
              <option value="web">Web app (gets an address)</option>
              <option value="backend">Back-end service (no public address)</option>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-sm">
            Domain (optional)
            <input
              name="host"
              placeholder="automatic on this server"
              class="rounded-md border border-border bg-background px-2 py-1.5"
            />
          </label>
        </div>
        {#if data.repos.find((r) => `${r.fullName}#${r.branch}` === source)?.authKind === 'github_app'}
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" name="autoDeploy" /> Deploy automatically on every push to this branch
          </label>
        {:else if source}
          <p class="text-xs text-foreground/55">
            This repo isn't connected through the GitHub App, so it's deployed by hand (Deploy now);
            there is no push-to-deploy.
          </p>
        {/if}
        <AppBuildForm
          nodeVersions={data.catalog?.runtimes.node ?? []}
          target={buildTarget}
          onsuggested={(s) => (kind = s.kind === 'service' ? 'backend' : 'web')}
        />
        {#if form?.action === 'deploy' && form.error}
          <p class="text-sm text-red-600" role="alert">{form.error}</p>
        {/if}
        <div>
          <button
            type="submit"
            disabled={deploying}
            class="rounded-md bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-60"
          >
            {deploying ? 'Deploying… this can take a few minutes' : 'Deploy'}
          </button>
        </div>
      </form>
    {/if}
  </section>
</div>
