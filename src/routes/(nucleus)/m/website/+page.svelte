<script lang="ts">
  import type { PageProps } from './$types'
  import GitBranch from '@lucide/svelte/icons/git-branch'
  import { resolve } from '$app/paths'
  import AppCard from '$lib/components/app-card.svelte'
  import SectionHeader from '$lib/components/page/section-header.svelte'
  import WebsiteActivityPanel from '$lib/components/website-activity-panel.svelte'
  import { docTitle } from '$lib/shell/title'

  let { data }: PageProps = $props()

  const apps = $derived(
    data.apps ? [...data.apps.services].sort((a, b) => a.name.localeCompare(b.name)) : [],
  )
  const repositories = $derived(data.apps?.repositories ?? data.savedRepositories)
  const unconfigured = $derived(
    data.apps
      ? data.apps.repositories.filter((repo) => repo.apps.length === 0)
      : data.savedRepositories,
  )
  const summary = $derived(
    [
      data.apps ? `${apps.length} ${apps.length === 1 ? 'app' : 'apps'}` : 'App status unavailable',
      `${repositories.length} connected ${repositories.length === 1 ? 'repository' : 'repositories'}`,
    ].join(' · '),
  )
  const repositoryFor = (repo: string, branch: string) =>
    repositories.find((r) => r.fullName.toLowerCase() === repo.toLowerCase() && r.branch === branch)
  const configureHref = (repo: string, branch: string) =>
    `${resolve('/m/website/apps/new')}?${new URLSearchParams({ repo, branch })}`
</script>

<svelte:head><title>{docTitle('Apps & repositories', 'Website')}</title></svelte:head>

<SectionHeader
  title="Apps & repositories"
  description="Build something new, connect your code, and manage where it runs."
/>
{#if data.apps || (data.appsError && !data.repositoriesError)}
  <div class="mt-2 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
    <span>{summary}</span>
    <a
      href={resolve('/m/website/settings')}
      class="inline-flex items-center gap-2 underline-offset-4 hover:underline"
      data-testid="deployment-server-status"
    >
      <span
        class={data.apps?.managed
          ? 'size-1.5 rounded-full bg-emerald-500'
          : 'size-1.5 rounded-full bg-foreground/30'}
        aria-hidden="true"
      ></span>
      {data.apps
        ? data.apps.managed
          ? 'Deployment server connected'
          : 'Connect a server to deploy'
        : 'Review deployment server'}
      <span aria-hidden="true">→</span>
    </a>
  </div>
{/if}

{#if data.appsError}
  <p class="mt-6 rounded-lg border border-red-500/25 p-4 text-sm text-red-600" role="alert">
    {data.appsError}
  </p>
{/if}

{#if data.repositoriesError}
  <p class="mt-3 rounded-lg border border-red-500/25 p-4 text-sm text-red-600" role="alert">
    Repositories could not be loaded. {data.repositoriesError}
  </p>
{/if}

<div class="mt-6 grid min-w-0 grid-cols-1 gap-10 xl:grid-cols-[minmax(0,1fr)_280px]">
  <section class="min-w-0" aria-label="Apps and repositories">
    {#if data.apps && apps.length === 0 && unconfigured.length === 0}
      <div
        class="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-border p-8 text-center"
      >
        <GitBranch class="mb-4 size-8 text-muted-foreground" strokeWidth={1.25} />
        <h2 class="text-base font-medium">Your next app starts here</h2>
        <p class="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
          Choose Add to build an app or website with chat, or connect a public or private GitHub
          repository.
        </p>
      </div>
    {:else}
      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
        {#each apps as app (app.name)}
          {@const repository = repositoryFor(app.repo, app.branch)}
          <AppCard
            name={app.name}
            kind={app.kind}
            state={app.status}
            domains={app.domains}
            url={app.url}
            repo={app.repo}
            branch={app.branch}
            rev={app.shortSha}
            lastDeploy={app.lastDeploy}
            managed={data.apps?.managed}
            visibility={repository?.visibility}
            authKind={repository?.authKind}
            href={resolve(`/m/website/apps/${app.name}`)}
          />
        {/each}
        {#each unconfigured as repo (`${repo.fullName}:${repo.branch}`)}
          <AppCard
            name={repo.fullName}
            kind="repository"
            domains={[]}
            url={null}
            repo={repo.fullName}
            branch={repo.branch}
            visibility={repo.visibility}
            authKind={repo.authKind}
            href={configureHref(repo.fullName, repo.branch)}
          />
        {/each}
      </div>
    {/if}
  </section>

  <section
    class="min-w-0 border-t border-border pt-6 xl:border-t-0 xl:pt-0"
    aria-label="Recent activity"
  >
    <WebsiteActivityPanel activity={data.activity} error={data.activityError} />
  </section>
</div>
