<script lang="ts">
  import type { PageData } from './$types'
  import { resolve } from '$app/paths'
  import RepoConnectSteps from '$lib/components/repo-connect-steps.svelte'
  import * as Breadcrumb from '$lib/components/ui/breadcrumb'

  /** /m/website/apps/new — adding an app from a repo (decision D-W4). */
  let { data }: { data: PageData } = $props()
</script>

<svelte:head><title>Add an app · Website · Eigen Enterprise</title></svelte:head>

<div class="mx-auto w-full max-w-4xl px-4 pt-6 pb-16 sm:px-8 sm:pt-10">
  <Breadcrumb.Root>
    <Breadcrumb.List>
      <Breadcrumb.Item>
        <Breadcrumb.Link href={resolve('/m/website')}>Website</Breadcrumb.Link>
      </Breadcrumb.Item>
      <Breadcrumb.Separator />
      <Breadcrumb.Item>
        <Breadcrumb.Link href={resolve('/m/website/apps')}>Apps</Breadcrumb.Link>
      </Breadcrumb.Item>
      <Breadcrumb.Separator />
      <Breadcrumb.Item>
        <Breadcrumb.Page>Add</Breadcrumb.Page>
      </Breadcrumb.Item>
    </Breadcrumb.List>
  </Breadcrumb.Root>

  <h1 class="mt-3 text-xl font-semibold tracking-tight">Add an app from a repo</h1>
  <p class="mt-1 text-sm text-muted-foreground">
    Pick the repo, say how this server may read it, then deploy it under a name.
  </p>

  <div class="mt-8">
    <RepoConnectSteps {data} />
  </div>
</div>
