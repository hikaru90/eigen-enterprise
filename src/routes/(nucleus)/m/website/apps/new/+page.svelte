<script lang="ts">
  import type { ActionData, PageData } from './$types'
  import { resolve } from '$app/paths'
  import RepoConnectSteps from '$lib/components/repo-connect-steps.svelte'
  import { docTitle } from '$lib/shell/title'

  /** /m/website/apps/new — adding an app from a repo (decision D-W4). */
  let { data, form }: { data: PageData; form: ActionData } = $props()

  // A submit that raced hydration (a native POST) still gets its plain
  // sentence back through the form prop — never a silent reload.
  const nativeError = form && 'error' in form && typeof form.error === 'string' ? form.error : null
</script>

<svelte:head><title>{docTitle('Add an app', 'Website')}</title></svelte:head>

<div class="max-w-3xl">
  <a
    href={resolve('/m/website')}
    class="mt-6 inline-block text-xs text-muted-foreground hover:underline"
    data-testid="back-link">← Back to apps</a
  >
  <h2 class="mt-2 text-base font-semibold tracking-tight">Connect a GitHub repository</h2>
  <p class="mt-1 text-sm text-muted-foreground">
    Connect your repository, verify access, then configure your app.
  </p>

  <div class="mt-8">
    <RepoConnectSteps {data} {nativeError} nativeResult={form} />
  </div>
</div>
