<script lang="ts">
  import type { PageProps } from './$types'
  import Plus from '@lucide/svelte/icons/plus'
  import { resolve } from '$app/paths'
  import AddAppDialog from '$lib/components/add-app-dialog.svelte'
  import AppCard from '$lib/components/app-card.svelte'
  import { Alert, AlertDescription, AlertTitle } from '$lib/components/ui/alert'

  /**
   * Apps: the one overview of what runs for the company on this server —
   * the site first, then every app by name, and the "+" card to add another.
   */

  let { data }: PageProps = $props()

  let addOpen = $state(false)

  const apps = $derived([...data.services].sort((a, b) => a.name.localeCompare(b.name)))
  const siteCard = $derived({
    name: 'Company site',
    kind: 'site' as const,
    domains: data.site.publicHost ? [data.site.publicHost] : [],
    url: data.site.url,
    href: resolve('/m/website/site'),
    pages: data.site.pages,
  })
</script>

<svelte:head><title>Apps · Website · Eigen Enterprise</title></svelte:head>

<div class="mx-auto w-full max-w-4xl px-4 pt-6 pb-16 sm:px-8 sm:pt-10">
  <header class="flex min-w-0 flex-col gap-1.5 border-b border-border pb-6">
    <a href={resolve('/m/website')} class="text-xs text-foreground/55 hover:text-foreground"
      >Website</a
    >
    <h1 class="text-xl font-semibold tracking-tight">Apps</h1>
    <p class="text-sm text-foreground/60">
      Your company site and everything built from your repos, running on this server.
    </p>
  </header>

  {#if !data.managed}
    <Alert class="mt-6" data-testid="apps-unmanaged">
      <AlertTitle>This server isn't managed by ee yet</AlertTitle>
      <AlertDescription>
        Install eigenEnterprise on a server with <code>ee</code> to manage domains and apps here.
      </AlertDescription>
    </Alert>
  {/if}

  <section class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2" aria-label="Apps">
    <AppCard {...siteCard} />
    {#each apps as s (s.name)}
      <AppCard
        name={s.name}
        kind={s.kind}
        state={s.status}
        domains={s.domains}
        url={s.url}
        repo={s.repo}
        branch={s.branch}
        rev={s.shortSha}
        lastDeploy={s.lastDeploy}
        href={resolve(`/m/website/apps/${s.name}`)}
      />
    {/each}
    <button
      type="button"
      class="flex min-h-32 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-foreground/55 hover:border-foreground/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      data-testid="add-app"
      onclick={() => (addOpen = true)}
    >
      <Plus class="size-6" strokeWidth={1.75} />
      <span class="text-sm">Add</span>
    </button>
  </section>
</div>

<AddAppDialog open={addOpen} onOpenChange={(o) => (addOpen = o)} />
