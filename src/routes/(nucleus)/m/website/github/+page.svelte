<script lang="ts">
  import type { PageData } from './$types'
  import { resolve } from '$app/paths'
  import GitHubAppConnect from '$lib/components/github-app-connect.svelte'
  import * as Breadcrumb from '$lib/components/ui/breadcrumb'

  /** /m/website/github — the GitHub App connection only (decision D-W4). */
  let { data }: { data: PageData } = $props()
</script>

<svelte:head><title>GitHub · Website · Eigen Enterprise</title></svelte:head>

<div class="mx-auto w-full max-w-4xl px-4 pt-6 pb-16 sm:px-8 sm:pt-10">
  <Breadcrumb.Root>
    <Breadcrumb.List>
      <Breadcrumb.Item>
        <Breadcrumb.Link href={resolve('/m/website')}>Website</Breadcrumb.Link>
      </Breadcrumb.Item>
      <Breadcrumb.Separator />
      <Breadcrumb.Item>
        <Breadcrumb.Page>GitHub</Breadcrumb.Page>
      </Breadcrumb.Item>
    </Breadcrumb.List>
  </Breadcrumb.Root>

  <header class="mt-3 border-b border-border pb-6">
    <h1 class="text-xl font-semibold tracking-tight">GitHub</h1>
    <p class="mt-1 text-sm text-muted-foreground">
      How this server may read your GitHub repositories.
    </p>
  </header>

  <GitHubAppConnect github={data.github} manifest={data.manifest} />
</div>
