<script lang="ts">
  import { resolve } from '$app/paths'
  import Wordmark from '$lib/components/page/wordmark.svelte'
  import { Button } from '$lib/components/ui/button'
  import { docTitle } from '$lib/shell/title'

  /**
   * The one error page body. Signed in: the way back is the dashboard. Signed out: the
   * way in is Sign in. Never an old-app link.
   */
  let {
    status,
    message,
    signedIn,
  }: { status: number; message: string | null | undefined; signedIn: boolean } = $props()

  const isNotFound = $derived(status === 404)
  const heading = $derived(isNotFound ? 'Page not found' : 'Something went wrong')
</script>

<svelte:head>
  <title>{docTitle(heading)}</title>
</svelte:head>

<div
  class="mx-auto flex w-full max-w-md flex-col items-center px-5 pt-16 pb-16 text-center"
  data-testid="error-page"
>
  {#if !signedIn}
    <div class="mb-8"><Wordmark /></div>
  {/if}
  <p class="text-xs text-muted-foreground tabular-nums">Error {status}</p>
  <h1 class="mt-2 text-xl font-semibold tracking-tight">{heading}</h1>
  {#if isNotFound}
    <p class="mt-2 text-sm text-foreground/60">This address does not exist (any more).</p>
  {:else if message}
    <p class="mt-2 text-xs text-foreground/60">{message}</p>
  {/if}
  {#if signedIn}
    <Button href={resolve('/')} class="mt-8" size="lg" data-testid="error-back">Back to the dashboard</Button
    >
  {:else}
    <Button href={resolve('/login')} class="mt-8" size="lg" data-testid="error-back">Sign in</Button
    >
  {/if}
</div>
