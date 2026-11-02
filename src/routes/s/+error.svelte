<script lang="ts">
  import { resolve } from '$app/paths'
  import { page } from '$app/state'
  import PublicSurface from '$lib/components/page/public-surface.svelte'

  /**
   * Errors on the public company site: for site visitors, so no "Sign in"
   * and no app chrome — just the way back to the site's pages.
   */
  const isNotFound = $derived(page.status === 404)
  const heading = $derived(isNotFound ? 'Page not found' : 'Something went wrong')
</script>

<svelte:head><title>{heading}</title></svelte:head>

<PublicSurface>
  <main
    class="mx-auto flex w-full max-w-md flex-col items-center px-4 pt-16 pb-16 text-center"
    data-testid="site-error"
  >
    <p class="text-xs text-muted-foreground tabular-nums">Error {page.status}</p>
    <h1 class="mt-2 text-xl font-semibold tracking-tight">{heading}</h1>
    <p class="mt-2 text-sm text-muted-foreground">
      {isNotFound ? 'This page does not exist (any more).' : 'Please try again in a moment.'}
    </p>
    <a
      href={resolve('/s')}
      class="mt-8 text-sm font-medium underline underline-offset-4"
      data-testid="site-error-back">See all pages</a
    >
  </main>
</PublicSurface>
