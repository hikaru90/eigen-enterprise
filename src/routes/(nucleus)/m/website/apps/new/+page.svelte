<script lang="ts">
  import type { ActionData, PageData } from './$types'
  import { resolve } from '$app/paths'
  import RepoConnectSteps from '$lib/components/repo-connect-steps.svelte'
  import * as Breadcrumb from '$lib/components/ui/breadcrumb'

  /** /m/website/apps/new — adding an app from a repo (decision D-W4). */
  let { data, form }: { data: PageData; form: ActionData } = $props()

  // A submit that raced hydration (a native POST) still gets its plain
  // sentence back through the form prop — never a silent reload.
  const nativeError = form && 'error' in form && typeof form.error === 'string' ? form.error : null
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
        <Breadcrumb.Page>Add an app</Breadcrumb.Page>
      </Breadcrumb.Item>
    </Breadcrumb.List>
  </Breadcrumb.Root>

  <h1 class="mt-3 text-xl font-semibold tracking-tight">Connect a GitHub repository</h1>
  <p class="mt-1 text-sm text-muted-foreground">
    Connect your repository, verify access, then configure your app.
  </p>

  <div class="mt-8">
    <RepoConnectSteps {data} {nativeError} nativeResult={form} />
  </div>
</div>
